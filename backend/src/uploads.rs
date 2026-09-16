//! Private host files referenced by Herdr message drafts; never served as web assets.
//! Any file type is accepted: the files are mode 0600 and never served back, so the only
//! reader is whatever the agent runs on the host.
use anyhow::{Result, bail};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
pub const MAX_BYTES: usize = 100 * 1024 * 1024;
/// The extension for a recognised image signature; agents get `Image:` lines for these.
fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("jpg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    if bytes.len() >= 16 && &bytes[4..8] == b"ftyp" {
        for brand in bytes[8..bytes.len().min(64)].as_chunks::<4>().0 {
            if [b"heic", b"heix", b"hevc", b"hevx"].contains(&brand) {
                return Some("heic");
            }
            if brand == b"mif1" || brand == b"msf1" {
                return Some("heif");
            }
        }
    }
    None
}
/// The client's file name reduced to one safe path component: the last segment, with
/// anything outside letters, digits, `.`, `-`, `_` and spaces replaced, leading dots and
/// spaces dropped, and at most 80 characters. `None` when nothing usable remains.
pub fn safe_name(name: &str) -> Option<String> {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_start_matches(['.', ' ']).trim_end();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(80).collect())
}
/// Which draft line an upload gets.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Kind {
    Image,
    File,
}
impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Image => "image",
            Kind::File => "file",
        }
    }
}
pub fn directory() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("Host home unavailable"))?;
    Ok(PathBuf::from(home).join(".local/share/omarchy-remote/uploads"))
}
/// Store an upload under a unique private name. A client name is kept (sanitised) so the
/// agent sees `report.zip`; unnamed uploads such as pasted screenshots are named by content.
pub fn store(directory: &Path, bytes: &[u8], name: Option<&str>) -> Result<(PathBuf, Kind)> {
    if bytes.is_empty() {
        bail!("File is empty");
    }
    if bytes.len() > MAX_BYTES {
        bail!("File is larger than 100 MB");
    }
    let image = image_extension(bytes);
    let kind = if image.is_some() {
        Kind::Image
    } else {
        Kind::File
    };
    let id = uuid::Uuid::new_v4();
    let file = match (name.and_then(safe_name), image) {
        (Some(name), _) => format!("{id}-{name}"),
        (None, Some(extension)) => format!("image-{id}.{extension}"),
        (None, None) => format!("file-{id}"),
    };
    fs::create_dir_all(directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    let path = directory.join(file);
    write_new(&path, bytes)?;
    Ok((path, kind))
}
pub fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    if let Err(error) = file.write_all(bytes) {
        let _ = fs::remove_file(path);
        return Err(error.into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn images_are_detected_from_content() {
        assert_eq!(image_extension(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(image_extension(b"\xff\xd8\xffx"), Some("jpg"));
        assert_eq!(image_extension(b"RIFF1234WEBP"), Some("webp"));
        assert_eq!(image_extension(b"\0\0\0\x18ftypheic\0\0\0\0"), Some("heic"));
        assert_eq!(image_extension(b"<svg onload='bad'>"), None);
        assert_eq!(image_extension(b"PK\x03\x04zip"), None);
    }
    #[test]
    fn names_are_reduced_to_one_safe_component() {
        assert_eq!(safe_name("report.zip").as_deref(), Some("report.zip"));
        assert_eq!(safe_name("../../etc/passwd").as_deref(), Some("passwd"));
        assert_eq!(
            safe_name("C:\\Users\\me\\My File (1).ZIP").as_deref(),
            Some("My File _1_.ZIP")
        );
        assert_eq!(safe_name(".hidden").as_deref(), Some("hidden"));
        assert_eq!(
            safe_name("nul\0byte\n.txt").as_deref(),
            Some("nul_byte_.txt")
        );
        assert_eq!(
            safe_name("données.tar.gz").as_deref(),
            Some("données.tar.gz")
        );
        assert_eq!(safe_name("..."), None);
        assert_eq!(safe_name("dir/"), None);
        assert_eq!(safe_name(&"a".repeat(200)).unwrap().chars().count(), 80);
    }
    #[test]
    fn uploads_are_private_unique_named_and_bounded() {
        let dir =
            std::env::temp_dir().join(format!("omarchy-upload-test-{}", uuid::Uuid::new_v4()));
        let bytes = b"GIF89aexample";
        let (first, kind) = store(&dir, bytes, None).unwrap();
        assert_eq!(kind, Kind::Image);
        assert!(first.to_str().unwrap().ends_with(".gif"));
        let (second, _) = store(&dir, bytes, None).unwrap();
        assert_ne!(first, second);
        assert_eq!(fs::read(&first).unwrap(), bytes);
        assert_eq!(
            fs::metadata(&first).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let (zip, kind) = store(&dir, b"PK\x03\x04zip", Some("../../report.zip")).unwrap();
        assert_eq!(kind, Kind::File);
        assert_eq!(zip.parent().unwrap(), dir);
        assert!(
            zip.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .ends_with("-report.zip")
        );
        let (blob, kind) = store(&dir, b"plain", Some("///")).unwrap();
        assert_eq!(kind, Kind::File);
        assert!(
            blob.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("file-")
        );
        assert!(store(&dir, &[], Some("empty.zip")).is_err());
        assert!(store(&dir, &vec![0; MAX_BYTES + 1], None).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
