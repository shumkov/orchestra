# Portable file-denial probe

## Problem

The U1a file-enforcement script tests protected files with the special builtin
redirection `exec 3<path`. Ubuntu `/bin/sh` is dash, which exits a
non-interactive shell with status 2 when that redirection is denied. The script
therefore never reaches its later CODEX_HOME and daemon-root checks, and the
checker cannot distinguish correct denial from probe failure.

The workspace marker uses the other special builtin `:` with redirection, so a
marker-write denial has the same dash behavior and cannot retain exit code 11.

## Chosen approach

Use the already required `/usr/bin/head -c 1 path` command for every protected
file probe. The script first uses the same executable to read the workspace
positive-control file, so a missing or unusable helper still fails with the
existing workspace-read exit code. A protected file is a failure only when
`head` can open it; denied or absent optional files let the script continue.
Create the workspace marker with regular `printf` redirection so a write denial
reaches the existing `|| exit 11` classification.

This keeps the existing arguments and exit-code contract:

- `10` and `11` remain workspace read/write failures;
- `12` and `13` remain readable CODEX_HOME config/auth failures;
- `30` remains a readable daemon-root sentinel;
- `0` means every required protected file was denied.

Darwin uses the same script and retains the same open/read enforcement
semantics. No package runtime or production client code changes.

## Alternatives rejected

- Wrapping `exec 3<path` in a subshell contains dash's fatal exit, but preserves
  the special-builtin portability trap and adds a second shell execution path.
- Shell permission predicates such as `[ -r path ]` do not prove the sandboxed
  command can actually open the file.
- Adding another helper such as `cat` or `dd` is unnecessary because `head` is
  already positively controlled and used for daemon-root probes.

## Failure modes and verification

Unreadable protected files continue to classify as denied. Readable protected
files retain their exact failure codes. An unavailable `head`, unreadable
workspace control, or unwritable workspace marker still fails closed before
protected-file classification.

The focused regression executes the generated script with `/bin/dash` against
a readable workspace control, writable marker, and denied/missing protected
paths. It must be red on the current `exec` form with exit 2 and green with exit
0 after the change. Companion cases verify readable CODEX_HOME and daemon-root
files retain exit 12/13/30, the generated script contains no descriptor `exec`,
and Darwin-facing command construction remains unchanged.

After the focused test passes, run the complete spike test and the full Node
24.4.0 suite, then obtain independent correctness/security/simplicity review.
