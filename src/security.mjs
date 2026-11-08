import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  linkSync,
  unlinkSync,
  lstatSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const windowsSystemBinary = (name) =>
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);

// Only this fixed program is executable text. Paths travel as JSON on stdin.
// Use the built-in .NET Framework APIs, independent of PowerShell module paths.
const windowsProtectionCommand = Buffer.from(`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$attributes = [IO.File]::GetAttributes($data.path)
if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Runtime storage cannot use reparse points.' }
$isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
if ($isDirectory -ne [bool]$data.directory) { throw 'Storage path type changed.' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($isDirectory) { $before = [IO.Directory]::GetAccessControl($data.path) }
else { $before = [IO.File]::GetAccessControl($data.path) }
$owner = $before.GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $sid.Value -and $owner -ne 'S-1-5-32-544' -and $owner -ne 'S-1-5-18') {
  throw 'Runtime storage must be owned by the current account or a local system administrator.'
}
$inherit = [Security.AccessControl.InheritanceFlags]::None
if ($isDirectory) {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else { $acl = [Security.AccessControl.FileSecurity]::new() }
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
  $sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow))
if ($isDirectory) {
  [IO.Directory]::SetAccessControl($data.path, $acl)
  $actual = [IO.Directory]::GetAccessControl($data.path)
} else {
  [IO.File]::SetAccessControl($data.path, $acl)
  $actual = [IO.File]::GetAccessControl($data.path)
}
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or
    $rules[0].IdentityReference.Value -ne $sid.Value -or
    $rules[0].AccessControlType -ne 'Allow' -or
    $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) {
  throw 'Private storage ACL verification failed.'
}
`, 'utf16le').toString('base64');

export function protectPath(destination, directory = false) {
  if (lstatSync(destination).isSymbolicLink())
    throw new Error('Private runtime storage cannot use symbolic links.');
  if (process.platform === 'win32') {
    try {
      execFileSync(
      windowsSystemBinary('WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-EncodedCommand', windowsProtectionCommand,
      ],
      {
        input: JSON.stringify({ path: path.resolve(destination), directory }),
        stdio: 'pipe', windowsHide: true, timeout: 10000,
      },
      );
    } catch (error) {
      throw new Error(
        'Cannot make runtime storage private on Windows. Use a path owned by this account and ensure built-in Windows PowerShell is available.',
        { cause: error },
      );
    }
  } else chmodSync(destination, directory ? 0o700 : 0o600);
}

export function prepareDirectory(directory) {
  const absolute = path.resolve(directory);
  if (existsSync(absolute)) {
    const allowed =
      /^(?:owner\.json|tls\.json|owner-client\.json|clients|runtime\.sqlite(?:-wal|-shm)?|host-lock\.sqlite(?:-journal)?|\.(?:owner|tls)\.json\.[a-f0-9-]{36}\.tmp)$/;
    if (readdirSync(absolute).some((name) => !allowed.test(name)))
      throw new Error(
        'Choose a dedicated, empty runtime directory. This path contains unrelated files.',
      );
  } else mkdirSync(absolute, { recursive: true, mode: 0o700 });
  let paths = 0;
  const protectTree = (destination, depth = 0) => {
    if (++paths > 11000 || depth > 16)
      throw new Error('The dedicated runtime storage tree exceeds its safe startup limit.');
    const stat = lstatSync(destination);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new Error('Runtime storage requires regular files and directories.');
    protectPath(destination, stat.isDirectory());
    if (stat.isDirectory())
      for (const name of readdirSync(destination))
        protectTree(path.join(destination, name), depth + 1);
  };
  // Existing database and client files may carry explicit ACLs of their own.
  protectTree(absolute);
  return absolute;
}

function privateDestination(destination) {
  const absolute = path.resolve(destination);
  if (
    process.platform === 'win32' &&
    path.relative(path.parse(absolute).root, absolute).includes(':')
  )
    throw new Error(
      'NTFS alternate data streams are not supported for credentials.',
    );
  return absolute;
}

// CLI output paths must be writable and exclusively reserved before a remote
// API issues a one-time credential or consumes a lease. The reserved file is
// private and empty until create returns; a process crash may leave it empty.
export async function withPrivateJsonOutput(destination, create) {
  const absolute = privateDestination(destination);
  const descriptor = openSync(absolute, 'wx', 0o600);
  let saved = false;
  try {
    protectPath(absolute);
    const value = await create();
    writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(descriptor);
    if (process.platform !== 'win32') {
      const directory = openSync(path.dirname(absolute), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    saved = true;
    return value;
  } finally {
    try { closeSync(descriptor); } finally {
      if (!saved) unlinkSync(absolute);
    }
  }
}

export function writePrivateJson(destination, value) {
  const absolute = privateDestination(destination);
  const temporary = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    protectPath(temporary);
    writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // A hard link publishes a fully written file atomically and refuses to
    // replace an existing destination, on both NTFS and POSIX local disks.
    linkSync(temporary, absolute);
    if (process.platform !== 'win32') {
      const directory = openSync(path.dirname(absolute), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
