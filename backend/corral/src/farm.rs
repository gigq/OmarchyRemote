//! The render farm, as each machine serves it: another machine sends a heavy job here, with its
//! input files, and this machine runs it through its own render queue and gives back the files it
//! made. `render-slot --on MACHINE` (or `--needs blender,cuda`) does the sending.
//!
//! A job lives in a folder of its own under `~/render-farm/<id>`. Files go in and come out as tar
//! streams, which `tar` reads and writes on Linux, macOS, and Windows alike. The job runs as
//! `render-slot run …` in that folder, so it takes its turn with this machine's own jobs; its
//! output goes to `.farm/log`, and its exit status to `.farm/exit` when it ends.
use super::*;
use axum::body::Body;
use futures_util::StreamExt;

/// The farm's folder, where each job has its own: `CORRAL_FARM_DIR`, or one in the home folder.
fn root() -> anyhow::Result<PathBuf> {
    if let Some(dir) = std::env::var_os("CORRAL_FARM_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    Ok(home_dir()
        .ok_or_else(|| anyhow::anyhow!("No home folder"))?
        .join(".cache/corral-farm"))
}
/// Copies of projects other machines keep here, synced with rsync, which split renders run in.
fn projects() -> anyhow::Result<PathBuf> {
    Ok(root()?.join("projects"))
}
/// A path inside the farm's project copies, which need not exist yet, or why not.
fn project_path(dir: &str) -> Result<PathBuf, ApiError> {
    let relative = FsPath::new(dir);
    if dir.is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(refuse(StatusCode::BAD_REQUEST, "Not a project folder"));
    }
    Ok(projects().map_err(error)?.join(relative))
}
/// A path inside the farm's project copies, or why not.
fn project(dir: &str) -> Result<PathBuf, ApiError> {
    let path = project_path(dir)?;
    if !path.is_dir() {
        return Err(refuse(
            StatusCode::NOT_FOUND,
            "That project is not copied here",
        ));
    }
    // Copies not used for two weeks go.
    let _ = fs::write(path.join(".farm-used"), crate::now());
    Ok(path)
}
/// A job's folder, for an id made of letters, digits, and dashes only.
fn folder(id: &str) -> Result<PathBuf, ApiError> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(refuse(StatusCode::BAD_REQUEST, "Not a job id"));
    }
    Ok(root().map_err(error)?.join(id))
}
/// The machine's farm settings, from `~/.config/render-slot.json`: its `tags` and `tools` (a
/// program's name and where it is, for programs not on the path, as Blender on Windows).
fn settings() -> Value {
    home_dir()
        .and_then(|h| fs::read(h.join(".config/render-slot.json")).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
/// The programs jobs ask for by name that this machine has.
fn tools() -> Vec<(String, PathBuf)> {
    let configured = settings()["tools"].as_object().cloned().unwrap_or_default();
    [
        "blender", "ffmpeg", "ffprobe", "node", "npx", "python3", "uv", "magick",
    ]
    .iter()
    .filter_map(|name| {
        let path = configured
            .get(*name)
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .or_else(|| program(name).ok())
            // Windows' store placeholder for Python is not Python.
            .filter(|p| !p.to_string_lossy().contains("WindowsApps"))?;
        Some(((*name).to_owned(), path))
    })
    .collect()
}
/// This machine's tags: those its settings give it, the programs it has, and its system.
pub fn tags() -> Vec<String> {
    let mut tags: Vec<String> = settings()["tags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t.as_str().map(str::to_owned))
        .collect();
    tags.extend(tools().into_iter().map(|(name, _)| name));
    tags.push(std::env::consts::OS.to_owned());
    tags.sort();
    tags.dedup();
    tags
}
/// What this machine offers the farm: its name, system, tags, and render queue.
pub async fn farm(State(corral): State<Corral>) -> Json<Value> {
    Json(json!({
        "name": corral.name,
        "os": std::env::consts::OS,
        "tags": tags(),
        "queue": crate::queue::snapshot(),
    }))
}
/// Starts `tar` in `dir` with `args`, its input and output piped.
async fn tar(dir: &FsPath, args: &[&str]) -> std::io::Result<tokio::process::Child> {
    let mut command = Command::new(if cfg!(windows) { "tar.exe" } else { "tar" });
    // macOS's tar would add its file attributes, which other systems' tar warn about.
    if cfg!(target_os = "macos") && args.first() == Some(&"-cf") {
        command.arg("--no-xattrs");
        // Nor its `._` files beside each one.
        command.env("COPYFILE_DISABLE", "1");
    }
    command
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.spawn()
}
/// A job's input files, as a tar stream, unpacked into its folder.
pub async fn put_files(Path(id): Path<String>, body: Body) -> Result<Json<Value>, ApiError> {
    let dir = folder(&id)?;
    fs::create_dir_all(dir.join(".farm")).map_err(error)?;
    let mut child = tar(&dir, &["-xf", "-"]).await.map_err(error)?;
    let mut stdin = child.stdin.take().ok_or_else(|| error("no input"))?;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        stdin
            .write_all(&chunk.map_err(error)?)
            .await
            .map_err(error)?;
    }
    drop(stdin);
    let out = child.wait_with_output().await.map_err(error)?;
    if !out.status.success() {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            &format!(
                "Could not unpack the files: {}",
                clip(&String::from_utf8_lossy(&out.stderr), 300)
            ),
        ));
    }
    Ok(Json(json!({"ok": true})))
}
#[derive(Deserialize)]
pub struct Job {
    command: Vec<String>,
    #[serde(default)]
    cores: usize,
    #[serde(default)]
    gpu: bool,
    #[serde(default)]
    label: String,
    /// The Corral place that sent it, so this machine's queue says whose it is.
    #[serde(default)]
    place: String,
    /// A project copy to run in, instead of the job's own folder.
    #[serde(default)]
    dir: String,
}
/// Starts a job in its folder through this machine's render queue.
pub async fn run_job(
    Path(id): Path<String>,
    Json(job): Json<Job>,
) -> Result<Json<Value>, ApiError> {
    let dir = folder(&id)?;
    let farm = dir.join(".farm");
    fs::create_dir_all(&farm).map_err(error)?;
    let Some(first) = job.command.first() else {
        return Err(refuse(StatusCode::BAD_REQUEST, "No command"));
    };
    // A program this machine keeps elsewhere, as Blender on Windows, is found by its name.
    let tools = tools();
    let program_path = tools
        .iter()
        .find(|(name, _)| name == first)
        .map_or_else(|| first.clone(), |(_, p)| p.display().to_string());
    let slot = std::env::current_exe()
        .ok()
        .and_then(|e| {
            e.parent().map(|p| {
                p.join(if cfg!(windows) {
                    "render-slot.exe"
                } else {
                    "render-slot"
                })
            })
        })
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("render-slot"));
    let mut args: Vec<String> = vec!["run".into(), "--cores".into(), job.cores.max(1).to_string()];
    if job.gpu {
        args.push("--gpu".into());
    }
    if !job.label.is_empty() {
        args.extend(["--label".into(), job.label.clone()]);
    }
    args.push("--".into());
    args.push(program_path);
    args.extend(job.command[1..].iter().cloned());
    let log = fs::File::create(farm.join("log")).map_err(error)?;
    let errors = log.try_clone().map_err(error)?;
    let cwd = if job.dir.is_empty() {
        dir.clone()
    } else {
        project(&job.dir)?
    };
    let mut child = Command::new(&slot)
        .args(&args)
        .current_dir(&cwd)
        .env("CORRAL_PLACE", &job.place)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(errors))
        .spawn()
        .map_err(|e| error(format!("{} could not start: {e}", slot.display())))?;
    let pid = child.id().unwrap_or_default();
    fs::write(farm.join("pid"), pid.to_string()).map_err(error)?;
    tokio::spawn(async move {
        let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
        let _ = fs::write(farm.join("exit"), code.to_string());
    });
    Ok(Json(json!({"started": true, "pid": pid})))
}
/// Where a job is: waiting in this machine's queue (and its place in line), running, or done
/// with its exit status; and the end of its log.
pub async fn job_status(Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let dir = folder(&id)?;
    let farm = dir.join(".farm");
    if !farm.is_dir() {
        return Err(not_found());
    }
    let log = fs::read(farm.join("log")).unwrap_or_default();
    let tail = String::from_utf8_lossy(&log[log.len().saturating_sub(4000)..]).into_owned();
    if let Ok(code) = fs::read_to_string(farm.join("exit")) {
        return Ok(Json(
            json!({"state": "done", "exit": code.trim().parse::<i32>().unwrap_or(-1), "log": tail}),
        ));
    }
    let pid: u32 = fs::read_to_string(farm.join("pid"))
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or_default();
    let queue = tokio::task::spawn_blocking(crate::queue::snapshot)
        .await
        .map_err(error)?;
    let ticket = queue.jobs.iter().find(|j| j.ticket.pid == pid);
    Ok(Json(match ticket {
        Some(j) if j.running => json!({"state": "running", "log": tail}),
        Some(j) => json!({"state": "waiting", "position": j.position, "log": tail}),
        None => json!({"state": "starting", "log": tail}),
    }))
}
#[derive(Deserialize)]
pub struct Paths {
    #[serde(default)]
    paths: String,
    /// A project copy to read from, instead of the job's folder.
    #[serde(default)]
    dir: String,
}
/// A job's output files, as a tar stream: the paths asked for, in its folder.
pub async fn get_files(
    Path(id): Path<String>,
    Query(query): Query<Paths>,
) -> Result<Response, ApiError> {
    let dir = if query.dir.is_empty() {
        folder(&id)?
    } else {
        project(&query.dir)?
    };
    let paths: Vec<&str> = query.paths.split('\n').filter(|p| !p.is_empty()).collect();
    if paths.is_empty() {
        return Err(refuse(StatusCode::BAD_REQUEST, "Name the files to send"));
    }
    for p in &paths {
        let missing = !dir.join(p).exists();
        let outside = FsPath::new(p).is_absolute() || p.split(['/', '\\']).any(|s| s == "..");
        if outside || missing {
            return Err(refuse(
                StatusCode::NOT_FOUND,
                &format!("The job did not make {p}"),
            ));
        }
    }
    let mut args = vec!["-cf", "-"];
    args.extend(paths);
    let mut child = tar(&dir, &args).await.map_err(error)?;
    drop(child.stdin.take());
    let stdout = child.stdout.take().ok_or_else(|| error("no output"))?;
    // The child goes with the stream, so it is reaped when the stream ends.
    let stream = futures_util::stream::unfold((stdout, child), |(mut out, child)| async move {
        use tokio::io::AsyncReadExt;
        let mut buffer = vec![0u8; 256 * 1024];
        match out.read(&mut buffer).await {
            Ok(0) | Err(_) => None,
            Ok(n) => {
                buffer.truncate(n);
                Some((Ok::<_, std::io::Error>(buffer), (out, child)))
            }
        }
    });
    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/x-tar")],
        Body::from_stream(stream),
    )
        .into_response())
}
#[derive(Deserialize)]
pub struct Listing {
    dir: String,
    /// The start of the files' paths, folder included, as `out/emu-war-12-`.
    prefix: String,
}
/// The files in a project copy whose paths start with `prefix`, as a split render's pieces.
pub async fn list(Query(query): Query<Listing>) -> Result<Json<Value>, ApiError> {
    let dir = project(&query.dir)?;
    let (folder, start) = query.prefix.rsplit_once('/').unwrap_or(("", &query.prefix));
    if folder.split('/').any(|s| s == "..") {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "Not a folder in the project",
        ));
    }
    let files: Vec<String> = fs::read_dir(dir.join(folder))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with(start).then(|| {
                if folder.is_empty() {
                    name
                } else {
                    format!("{folder}/{name}")
                }
            })
        })
        .collect();
    Ok(Json(json!({"files": files})))
}
#[derive(Deserialize)]
pub struct Plan {
    dir: String,
    /// Each file the sender has: its path in the project, size, and when it changed (seconds).
    files: Vec<(String, u64, u64)>,
}
fn modified(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}
/// Which of the sender's files this machine's copy of a project lacks or has another version of,
/// so only those are sent. Makes the copy's folder if it has none.
pub async fn sync_plan(Json(plan): Json<Plan>) -> Result<Json<Value>, ApiError> {
    let dir = project_path(&plan.dir)?;
    fs::create_dir_all(&dir).map_err(error)?;
    let _ = fs::write(dir.join(".farm-used"), crate::now());
    let need: Vec<&str> = plan
        .files
        .iter()
        .filter(|(path, size, changed)| {
            let outside =
                path.split(['/', '\\']).any(|p| p == "..") || FsPath::new(path).is_absolute();
            let same = fs::metadata(dir.join(path))
                .is_ok_and(|m| m.len() == *size && modified(&m).abs_diff(*changed) <= 1);
            !outside && !same
        })
        .map(|(path, _, _)| path.as_str())
        .collect();
    Ok(Json(json!({"need": need})))
}
#[derive(Deserialize)]
pub struct Dir {
    dir: String,
}
/// Files into a project copy, as a tar stream, which keeps when each changed.
pub async fn sync_files(Query(query): Query<Dir>, body: Body) -> Result<Json<Value>, ApiError> {
    let dir = project_path(&query.dir)?;
    fs::create_dir_all(&dir).map_err(error)?;
    let mut child = tar(&dir, &["-xf", "-"]).await.map_err(error)?;
    let mut stdin = child.stdin.take().ok_or_else(|| error("no input"))?;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        stdin
            .write_all(&chunk.map_err(error)?)
            .await
            .map_err(error)?;
    }
    drop(stdin);
    let out = child.wait_with_output().await.map_err(error)?;
    if !out.status.success() {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            &format!(
                "Could not unpack the files: {}",
                clip(&String::from_utf8_lossy(&out.stderr), 300)
            ),
        ));
    }
    Ok(Json(json!({"ok": true})))
}
#[derive(Deserialize)]
pub struct Changed {
    dir: String,
    /// The job whose start counts: what changed in the copy since then.
    job: String,
}
/// The files in a project copy that changed since a job started there: what it made.
pub async fn changed(Query(query): Query<Changed>) -> Result<Json<Value>, ApiError> {
    let dir = project(&query.dir)?;
    let since = fs::metadata(folder(&query.job)?.join(".farm").join("pid"))
        .map(|m| modified(&m))
        .map_err(|_| not_found())?;
    let mut found = Vec::new();
    let mut walk = vec![dir.clone()];
    while let Some(d) = walk.pop() {
        for entry in fs::read_dir(&d).into_iter().flatten().flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "__pycache__"
                || name == ".farm-used"
                || name.ends_with(".pyc")
                || name.starts_with("._")
            {
                continue;
            }
            match entry.metadata() {
                Ok(m) if m.is_dir() => walk.push(path),
                Ok(m) if modified(&m) >= since => {
                    if let Ok(rel) = path.strip_prefix(&dir) {
                        found.push(rel.to_string_lossy().replace('\\', "/"));
                    }
                }
                _ => {}
            }
        }
    }
    found.sort();
    Ok(Json(json!({"files": found})))
}
/// Files from a project copy, as a tar stream: for lists too long for a query.
pub async fn fetch(Json(query): Json<Paths>) -> Result<Response, ApiError> {
    get_files(Path(String::from("fetch")), Query(query)).await
}
/// Removes files a split render made in a project copy, once they are back.
pub async fn tidy(Json(query): Json<Paths>) -> Result<Json<Value>, ApiError> {
    let dir = project(&query.dir)?;
    let mut gone = 0;
    for p in query.paths.split('\n').filter(|p| !p.is_empty()) {
        let outside = FsPath::new(p).is_absolute() || p.split(['/', '\\']).any(|s| s == "..");
        if !outside && fs::remove_file(dir.join(p)).is_ok() {
            gone += 1;
        }
    }
    Ok(Json(json!({"removed": gone})))
}
/// The sender removes a job's folder as soon as its files are back; a finished job it never came
/// back for goes after this long, and one that never started, after this long.
const KEEP_FINISHED: Duration = Duration::from_secs(10 * 60);
const KEEP_ABANDONED: Duration = Duration::from_secs(3600);
/// A project copy no split render has used for this long goes.
const KEEP_PROJECT: Duration = Duration::from_secs(3 * 24 * 3600);
/// How long since a file last changed.
fn age(path: &FsPath) -> Option<Duration> {
    fs::metadata(path).ok()?.modified().ok()?.elapsed().ok()
}
/// Removes the folders of jobs that are done or abandoned, so the farm does not fill the disk:
/// the sender removes a job's folder once its files are back, and this catches the rest. Returns
/// how many went.
pub fn sweep() -> usize {
    let Ok(root) = root() else {
        return 0;
    };
    let queued: Vec<u32> = crate::queue::snapshot()
        .jobs
        .iter()
        .map(|j| j.ticket.pid)
        .collect();
    let mut gone = 0;
    // Project copies, two levels down (`projects/<group>/<project>`), go when unused.
    if let Ok(copies) = projects() {
        for marker in walk_markers(&copies, 4) {
            if age(&marker).is_some_and(|a| a > KEEP_PROJECT)
                && let Some(project) = marker.parent()
                && fs::remove_dir_all(project).is_ok()
            {
                gone += 1;
            }
        }
    }
    for entry in fs::read_dir(&root).into_iter().flatten().flatten() {
        let dir = entry.path();
        if entry.file_name() == "projects" {
            continue;
        }
        let farm = dir.join(".farm");
        let stale = match age(&farm.join("exit")) {
            Some(age) => age > KEEP_FINISHED,
            None => {
                let pid: u32 = fs::read_to_string(farm.join("pid"))
                    .ok()
                    .and_then(|p| p.trim().parse().ok())
                    .unwrap_or_default();
                !queued.contains(&pid) && age(&dir).is_none_or(|age| age > KEEP_ABANDONED)
            }
        };
        if stale && fs::remove_dir_all(&dir).is_ok() {
            gone += 1;
        }
    }
    gone
}
/// `.farm-used` markers in project copies, down to `depth` folders.
fn walk_markers(dir: &FsPath, depth: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if dir.join(".farm-used").is_file() {
        found.push(dir.join(".farm-used"));
        return found;
    }
    if depth > 0 {
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            if entry.path().is_dir() {
                found.extend(walk_markers(&entry.path(), depth - 1));
            }
        }
    }
    found
}
/// Stops a job, as a split render does with a piece another machine finished first.
pub async fn stop_job(Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let farm = folder(&id)?.join(".farm");
    let pid: i32 = fs::read_to_string(farm.join("pid"))
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .ok_or_else(not_found)?;
    #[cfg(unix)]
    // SAFETY: a signal to the job's own process, which this Corral started.
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
    Ok(Json(json!({"stopped": true})))
}
/// Removes a job's folder, once its files are back.
pub async fn delete_job(Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let dir = folder(&id)?;
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(error)?;
    }
    Ok(Json(json!({"deleted": true})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finished_and_abandoned_jobs_are_swept_and_others_kept() {
        let root = std::env::temp_dir().join(format!("farm-sweep-{}", uuid::Uuid::new_v4()));
        // SAFETY: the only test that sets the farm's folder.
        unsafe { std::env::set_var("CORRAL_FARM_DIR", &root) };
        let job = |id: &str, exit: Option<u64>, abandoned: bool| {
            let farm = root.join(id).join(".farm");
            fs::create_dir_all(&farm).unwrap();
            fs::write(root.join(id).join("frame.png"), "x").unwrap();
            let long_ago = std::time::SystemTime::now() - Duration::from_secs(48 * 3600);
            if let Some(minutes) = exit {
                let file = fs::File::create(farm.join("exit")).unwrap();
                let then = std::time::SystemTime::now() - Duration::from_secs(minutes * 60);
                file.set_modified(then).unwrap();
            } else {
                fs::write(farm.join("pid"), "999999999").unwrap();
            }
            if abandoned {
                fs::File::open(root.join(id))
                    .unwrap()
                    .set_modified(long_ago)
                    .unwrap();
            }
        };
        job("old-finished", Some(30), false);
        job("new-finished", Some(2), false);
        job("abandoned", None, true);
        job("just-sent", None, false);
        assert_eq!(sweep(), 2);
        let mut left: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["just-sent", "new-finished"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn job_ids_are_plain_names() {
        assert!(folder("4c4a3bf1-82254527").is_ok());
        for bad in ["", "../x", "a/b", "a\\b", "x y"] {
            assert!(folder(bad).is_err(), "{bad}");
        }
    }
}
