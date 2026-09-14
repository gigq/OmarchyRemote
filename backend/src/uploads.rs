//! Private host files referenced by Herdr message drafts; never served as web assets.
use anyhow::{Result, bail};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
fn extension(bytes: &[u8]) -> Result<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok("png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Ok("jpg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Ok("gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok("webp");
    }
    if bytes.len() >= 16 && &bytes[4..8] == b"ftyp" {
        for brand in bytes[8..bytes.len().min(64)].as_chunks::<4>().0 {
            if [b"heic", b"heix", b"hevc", b"hevx"].contains(&brand) {
                return Ok("heic");
            }
            if brand == b"mif1" || brand == b"msf1" {
                return Ok("heif");
            }
        }
    }
    bail!("Choose a PNG, JPEG, GIF, WebP or HEIC image")
}
pub fn directory() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("Host home unavailable"))?;
    Ok(PathBuf::from(home).join(".local/share/omarchy-remote/uploads"))
}
pub fn store(directory: &Path, bytes: &[u8]) -> Result<PathBuf> {
    if bytes.is_empty() {
        bail!("Image is empty");
    }
    if bytes.len() > MAX_BYTES {
        bail!("Image is larger than 10 MB");
    }
    let extension = extension(bytes)?;
    fs::create_dir_all(directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    let path = directory.join(format!("image-{}.{}", uuid::Uuid::new_v4(), extension));
    write_new(&path, bytes)?;
    Ok(path)
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
    fn types_are_detected_from_content() {
        assert_eq!(extension(b"\x89PNG\r\n\x1a\nrest").unwrap(), "png");
        assert_eq!(extension(b"\xff\xd8\xffx").unwrap(), "jpg");
        assert_eq!(extension(b"RIFF1234WEBP").unwrap(), "webp");
        assert_eq!(extension(b"\0\0\0\x18ftypheic\0\0\0\0").unwrap(), "heic");
        assert!(extension(b"<svg onload='bad'>").is_err());
    }
    #[test]
    fn uploads_are_private_unique_and_bounded() {
        let dir =
            std::env::temp_dir().join(format!("omarchy-upload-test-{}", uuid::Uuid::new_v4()));
        let bytes = b"GIF89aexample";
        let first = store(&dir, bytes).unwrap();
        let second = store(&dir, bytes).unwrap();
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
        assert!(store(&dir, &[]).is_err());
        assert!(store(&dir, &vec![0; MAX_BYTES + 1]).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
