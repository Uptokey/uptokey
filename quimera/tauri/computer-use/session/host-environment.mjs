// Locate local tools and the user's OS runtime without forwarding API secrets.
export function hostEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|USER|LOGNAME|APPDATA|LOCALAPPDATA|PROGRAMDATA|COMSPEC|HOME|XDG_RUNTIME_DIR)$/i.test(key)));
}
