//! Windows ownership for the computer-use helper and all its descendants.
//!
//! The child starts suspended, joins a non-breakaway job, and only then runs.
//! Closing this owner's non-inheritable handle kills the entire process tree,
//! including when Windows closes the handle after an abrupt desktop exit.
use std::{
    mem::{size_of, zeroed},
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Child, Command},
    ptr::null,
};
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            GetProcessIdOfThread, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
            THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
        },
    },
};

pub(super) struct OwnedJob(OwnedHandle);

impl OwnedJob {
    pub(super) fn spawn(command: &mut Command) -> Result<(Child, Self), &'static str> {
        let job = Self::new()?;
        // No user code or descendants can run between spawn and job assignment.
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let mut child = command
            .spawn()
            .map_err(|_| "computer-session-unavailable")?;
        let result = unsafe {
            if AssignProcessToJobObject(job.0.as_raw_handle(), child.as_raw_handle()) == 0 {
                Err("computer-process-ownership-unavailable")
            } else {
                resume_owned_child(child.id())
            }
        };
        if let Err(error) = result {
            // Also covers assignment failure, when the job does not own the
            // suspended child yet. Never return a live unowned helper.
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok((child, job))
    }

    fn new() -> Result<Self, &'static str> {
        unsafe {
            // Null security attributes make the handle non-inheritable; no
            // name is published and no breakaway flag is permitted.
            let handle = CreateJobObjectW(null(), null());
            if handle.is_null() {
                return Err("computer-process-ownership-unavailable");
            }
            let job = Self(OwnedHandle::from_raw_handle(handle));
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err("computer-process-ownership-unavailable");
            }
            Ok(job)
        }
    }
}

// Stable std::process::Child exposes the process handle, but not the primary
// thread handle. ToolHelp supplies only thread metadata here; only the freshly
// spawned, still-suspended child's thread is opened. No foreign thread is opened
// or modified, and no process/module/memory contents are inspected.
unsafe fn resume_owned_child(pid: u32) -> Result<(), &'static str> {
    let raw = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if raw == INVALID_HANDLE_VALUE {
        return Err("computer-process-resume-unavailable");
    }
    let snapshot = OwnedHandle::from_raw_handle(raw);
    let mut entry: THREADENTRY32 = zeroed();
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    let mut found = None;
    let mut count = 0;
    let mut present = Thread32First(snapshot.as_raw_handle(), &mut entry);
    while present != 0 {
        count += 1;
        if count > 65_536 {
            return Err("computer-process-resume-unavailable");
        }
        if entry.th32OwnerProcessID == pid && found.replace(entry.th32ThreadID).is_some() {
            return Err("computer-process-resume-unavailable");
        }
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        present = Thread32Next(snapshot.as_raw_handle(), &mut entry);
    }
    if GetLastError() != ERROR_NO_MORE_FILES {
        return Err("computer-process-resume-unavailable");
    }
    let tid = found.ok_or("computer-process-resume-unavailable")?;
    let raw = OpenThread(
        THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
        0,
        tid,
    );
    if raw.is_null() {
        return Err("computer-process-resume-unavailable");
    }
    let thread = OwnedHandle::from_raw_handle(raw);
    if GetProcessIdOfThread(thread.as_raw_handle()) != pid
        || ResumeThread(thread.as_raw_handle()) != 1
    {
        return Err("computer-process-resume-unavailable");
    }
    Ok(())
}
