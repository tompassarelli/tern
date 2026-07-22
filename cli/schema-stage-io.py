#!/usr/bin/env python3
"""Read and publish schema-owned objects through pinned Linux FDs.

This is the narrow platform boundary Babashka cannot express: its SCI runtime
filters Java SecureDirectoryStream. Linux has no unlink-by-file-descriptor
operation, so this helper never turns an identity check into a later pathname
delete. Stale private staging is deliberately retained. Publication copies from
a pinned source FD into O_TMPFILE and links that anonymous inode with
linkat(AT_EMPTY_PATH); a replaced source name can neither redirect publication
nor be deleted by a later pathname operation. Finalized readers return the bytes
read from the same descriptor whose inode, mode, link count, and parent identity
they validated. Final manifest publication holds one exclusive advisory lock on
the pinned store directory while both referenced payload descriptors remain
open across the manifest link and its post-link verification.
"""

import ctypes
import errno
import fcntl
import json
import hashlib
import os
import stat
import sys


MARKER = ".north-schema-stage.edn"
OBJECT_FILES = {
    "workspace": {"coordination.log", "telemetry.log", "workspace.edn"},
    "candidate": {"coordination.log", "telemetry.log", "manifest.edn"},
}
AT_EMPTY_PATH = 0x1000
MAX_STDIN_OBJECT_BYTES = 16 * 1024 * 1024
FINALIZED_PAYLOAD_ROLES = ("coordination", "telemetry")
FINALIZED_FILE_MODE = 0o444
REFERENCE_FIELDS = {"role", "object_name", "sha256", "bytes"}
LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.linkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                        ctypes.c_char_p, ctypes.c_int]
LIBC.linkat.restype = ctypes.c_int


def fail(message, **evidence):
    raise RuntimeError(json.dumps({"ok": False, "error": message, **evidence}, sort_keys=True))


def identity(row):
    return {
        "dev": row.st_dev,
        "ino": row.st_ino,
        "uid": row.st_uid,
        "mode": stat.S_IMODE(row.st_mode),
        "kind": stat.S_IFMT(row.st_mode),
    }


def file_state(row):
    return {
        **identity(row),
        "nlink": row.st_nlink,
        "size": row.st_size,
        "mtime_ns": row.st_mtime_ns,
        "ctime_ns": row.st_ctime_ns,
    }


def expect(actual, expected, label):
    observed = identity(actual)
    if observed != expected:
        fail(f"{label} identity changed", expected=expected, actual=observed)
    return observed


def expect_file_state(actual, expected, label):
    observed = file_state(actual)
    if observed != expected:
        fail(f"{label} file state changed", expected=expected, actual=observed)
    return observed


def lstat_at(fd, name):
    return os.stat(name, dir_fd=fd, follow_symlinks=False)


def open_dir_at(fd, name):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)


def fsync_dir(fd):
    os.fsync(fd)


def same_inode(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def link_fd(fd, parent_fd, name):
    result = LIBC.linkat(fd, b"", parent_fd, os.fsencode(name), AT_EMPTY_PATH)
    if result != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number), name)


def open_pinned_parent(parent, label):
    before = os.stat(parent, follow_symlinks=False)
    if not stat.S_ISDIR(before.st_mode):
        fail(f"{label} parent is not a directory", actual=identity(before))
    expected = identity(before)
    parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    expect(os.fstat(parent_fd), expected, f"opened {label} parent")
    return parent_fd, expected


def expect_parent_path(parent, parent_fd, expected, label):
    expect(os.fstat(parent_fd), expected, f"pinned {label} parent")
    expect(os.stat(parent, follow_symlinks=False), expected,
           f"named {label} parent")


def lock_parent(parent_fd, exclusive, label):
    mode = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
    try:
        fcntl.flock(parent_fd, mode)
    except OSError as error:
        fail(f"cannot lock {label} parent", errno=error.errno)


def inspect_stage(parent, stage_name, kind, expected_stage, expected_marker):
    if kind not in OBJECT_FILES:
        fail("unsupported stage kind", kind=kind)
    if not os.path.isabs(parent) or os.path.basename(stage_name) != stage_name:
        fail("parent must be absolute and stage name must be one component")

    parent_fd, parent_identity = open_pinned_parent(parent, "stage")
    try:
        stage_before = lstat_at(parent_fd, stage_name)
        expect(stage_before, expected_stage, "stage")
        if not stat.S_ISDIR(stage_before.st_mode):
            fail("stage is not a directory")
        stage_fd = open_dir_at(parent_fd, stage_name)
        try:
            expect(os.fstat(stage_fd), expected_stage, "opened stage")
            names = set(os.listdir(stage_fd))
            if not names.issubset({MARKER, "object"}) or MARKER not in names:
                fail("stage contains an unknown or missing entry", entries=sorted(names))

            if "object" in names:
                object_before = lstat_at(stage_fd, "object")
                if not stat.S_ISDIR(object_before.st_mode):
                    fail("stage object is not a directory", actual=identity(object_before))
                if object_before.st_uid != expected_stage["uid"]:
                    fail("stage object owner differs from stage owner")
                object_identity = identity(object_before)
                object_fd = open_dir_at(stage_fd, "object")
                try:
                    expect(os.fstat(object_fd), object_identity, "opened stage object")
                    object_names = set(os.listdir(object_fd))
                    if not object_names.issubset(OBJECT_FILES[kind]):
                        fail("stage object contains an unknown entry",
                             entries=sorted(object_names))
                    sealed_entries = {}
                    for name in sorted(object_names):
                        before = lstat_at(object_fd, name)
                        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                            fail("stage object entry is not an unaliased regular file",
                                 entry=name, actual=identity(before), nlink=before.st_nlink)
                        if before.st_uid != expected_stage["uid"]:
                            fail("stage object entry owner differs from stage owner", entry=name)
                        sealed = identity(before)
                        sealed_entries[name] = sealed
                        expect(lstat_at(object_fd, name), sealed, f"object entry {name}")
                    if set(os.listdir(object_fd)) != object_names:
                        fail("stage object changed during inspection")
                    for name, sealed in sorted(sealed_entries.items()):
                        expect(lstat_at(object_fd, name), sealed,
                               f"object entry {name}")
                    expect(os.fstat(object_fd), object_identity, "stage object")
                finally:
                    os.close(object_fd)
                expect(lstat_at(stage_fd, "object"), object_identity, "stage object")

            marker_before = lstat_at(stage_fd, MARKER)
            expect(marker_before, expected_marker, "stage marker")
            if not stat.S_ISREG(marker_before.st_mode) or marker_before.st_nlink != 1:
                fail("stage marker is not an unaliased regular file",
                     nlink=marker_before.st_nlink)
            expect(lstat_at(stage_fd, MARKER), expected_marker, "stage marker")
            if set(os.listdir(stage_fd)) != names:
                fail("stage changed during inspection")
            expect(os.fstat(stage_fd), expected_stage, "stage")
        finally:
            os.close(stage_fd)

        expect(lstat_at(parent_fd, stage_name), expected_stage, "stage")
        expect_parent_path(parent, parent_fd, parent_identity, "stage")
        return {"ok": True, "retained": stage_name,
                "reason": "linux-has-no-identity-conditional-unlink"}
    finally:
        os.close(parent_fd)


def sha256_fd(fd):
    digest = hashlib.sha256()
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        block = os.read(fd, 65536)
        if not block:
            break
        digest.update(block)
    return digest.hexdigest()


def bytes_fd(fd):
    blocks = []
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        block = os.read(fd, 65536)
        if not block:
            break
        blocks.append(block)
    return b"".join(blocks)


def write_all(fd, payload):
    view = memoryview(payload)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def copy_fd(source_fd, target_fd):
    os.lseek(source_fd, 0, os.SEEK_SET)
    while True:
        block = os.read(source_fd, 65536)
        if not block:
            break
        write_all(target_fd, block)


def publish_tmp_fd(parent_fd, target_name, tmp_fd, expected_sha256, label):
    if sha256_fd(tmp_fd) != expected_sha256:
        fail(f"anonymous {label} copy differs from expected bytes")
    os.fchmod(tmp_fd, 0o444)
    os.fsync(tmp_fd)
    sealed_tmp = os.fstat(tmp_fd)

    created = False
    try:
        link_fd(tmp_fd, parent_fd, target_name)
        created = True
    except OSError as error:
        if error.errno != errno.EEXIST:
            raise

    target_before = lstat_at(parent_fd, target_name)
    if (not stat.S_ISREG(target_before.st_mode)
            or target_before.st_nlink != 1
            or stat.S_IMODE(target_before.st_mode) != 0o444
            or target_before.st_uid != sealed_tmp.st_uid):
        fail(f"{label} target is not an immutable owned file",
             actual=identity(target_before), nlink=target_before.st_nlink)
    if created and not same_inode(target_before, sealed_tmp):
        fail(f"new {label} target no longer names the anonymous published inode")
    target_identity = identity(target_before)
    target_fd = os.open(target_name, os.O_RDONLY | os.O_NOFOLLOW,
                        dir_fd=parent_fd)
    try:
        expect(os.fstat(target_fd), target_identity, f"opened {label} target")
        actual_sha256 = sha256_fd(target_fd)
        if actual_sha256 != expected_sha256:
            fail(f"{label} target has different bytes",
                 expected=expected_sha256, actual=actual_sha256)
        byte_count = os.fstat(target_fd).st_size
        expect(lstat_at(parent_fd, target_name), target_identity,
               f"{label} target")
    finally:
        os.close(target_fd)
    fsync_dir(parent_fd)
    expect(lstat_at(parent_fd, target_name), target_identity,
           f"durable {label} target")
    return {"ok": True, "target": target_name, "created": created,
            "sha256": expected_sha256, "bytes": byte_count,
            "identity": target_identity}


def read_object(parent, name, expected_parent=None):
    if not os.path.isabs(parent) or os.path.basename(name) != name:
        fail("object parent must be absolute and name must be one component")
    parent_fd, parent_identity = open_pinned_parent(parent, "object reader")
    try:
        lock_parent(parent_fd, False, "object reader")
        if expected_parent is not None and parent_identity != expected_parent:
            fail("object reader parent differs from reserved authority",
                 expected=expected_parent, actual=parent_identity)
        before = lstat_at(parent_fd, name)
        if (not stat.S_ISREG(before.st_mode)
                or before.st_nlink != 1):
            fail("object reader target is not an unaliased regular file",
                 actual=file_state(before))
        sealed = file_state(before)
        object_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW,
                            dir_fd=parent_fd)
        try:
            expect_file_state(os.fstat(object_fd), sealed,
                              "opened object reader target")
            first = bytes_fd(object_fd)
            second = bytes_fd(object_fd)
            if first != second:
                fail("object reader bytes changed between pinned reads")
            expect_file_state(os.fstat(object_fd), sealed,
                              "pinned object reader target")
            expect_file_state(lstat_at(parent_fd, name), sealed,
                              "named object reader target")
        finally:
            os.close(object_fd)
        expect_parent_path(parent, parent_fd, parent_identity, "object reader")
        evidence = {
            "ok": True,
            "target": name,
            "sha256": hashlib.sha256(first).hexdigest(),
            "bytes": len(first),
            "identity": identity(before),
            "file_state": sealed,
            "parent_identity": parent_identity,
        }
        return evidence, first
    finally:
        os.close(parent_fd)


def inspect_owned_file(parent, name, expected):
    if not os.path.isabs(parent) or os.path.basename(name) != name:
        fail("parent must be absolute and file name must be one component")
    parent_fd, parent_identity = open_pinned_parent(parent, "retained file")
    try:
        before = lstat_at(parent_fd, name)
        expect(before, expected, "owned file")
        if not stat.S_ISREG(before.st_mode):
            fail("owned file is not regular")
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            expect(os.fstat(file_fd), expected, "opened owned file")
            expect(lstat_at(parent_fd, name), expected, "owned file")
        finally:
            os.close(file_fd)
        expect_parent_path(parent, parent_fd, parent_identity, "retained file")
        return {"ok": True, "retained": name,
                "reason": "linux-has-no-identity-conditional-unlink"}
    finally:
        os.close(parent_fd)


def publish_receipt(parent, stage_name, target_name, expected_stage,
                    expected_sha256, expected_parent=None):
    if not os.path.isabs(parent):
        fail("receipt parent must be absolute")
    if os.path.basename(stage_name) != stage_name or os.path.basename(target_name) != target_name:
        fail("receipt names must each be one path component")
    if len(expected_sha256) != 64:
        fail("receipt SHA-256 is malformed")
    parent_fd, parent_identity = open_pinned_parent(parent, "receipt")
    try:
        lock_parent(parent_fd, True, "receipt")
        if expected_parent is not None and parent_identity != expected_parent:
            fail("receipt parent differs from reserved authority",
                 expected=expected_parent, actual=parent_identity)
        stage_before = lstat_at(parent_fd, stage_name)
        expect(stage_before, expected_stage, "receipt stage")
        if not stat.S_ISREG(stage_before.st_mode) or stage_before.st_nlink != 1:
            fail("receipt stage is not an unaliased regular file",
                 nlink=stage_before.st_nlink)
        stage_fd = os.open(stage_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            expect(os.fstat(stage_fd), expected_stage, "opened receipt stage")
            actual_sha256 = sha256_fd(stage_fd)
            if actual_sha256 != expected_sha256:
                fail("receipt stage bytes differ from the expected identity",
                     expected=expected_sha256, actual=actual_sha256)
            tmp_fd = os.open(".", os.O_RDWR | os.O_TMPFILE, 0o600,
                             dir_fd=parent_fd)
            try:
                copy_fd(stage_fd, tmp_fd)
                published = publish_tmp_fd(parent_fd, target_name, tmp_fd,
                                           expected_sha256, "receipt")
            finally:
                os.close(tmp_fd)

            try:
                source_retained = identity(lstat_at(parent_fd, stage_name)) == expected_stage
            except FileNotFoundError:
                source_retained = False
            expect_parent_path(parent, parent_fd, parent_identity, "receipt")
            return {**published, "source_retained": source_retained,
                    "parent_identity": parent_identity}
        finally:
            os.close(stage_fd)
    finally:
        os.close(parent_fd)


def publish_file_object(parent, source, target_name, expected_source,
                        expected_sha256, expected_parent=None):
    if (not os.path.isabs(parent) or not os.path.isabs(source)
            or os.path.basename(target_name) != target_name):
        fail("object parent/source must be absolute and target must be one component")
    if len(expected_sha256) != 64:
        fail("object SHA-256 is malformed")
    parent_fd, parent_identity = open_pinned_parent(parent, "candidate payload")
    try:
        lock_parent(parent_fd, True, "candidate payload")
        if expected_parent is not None and parent_identity != expected_parent:
            fail("candidate payload parent differs from reserved authority",
                 expected=expected_parent, actual=parent_identity)
        source_before = os.lstat(source)
        expect(source_before, expected_source, "object source")
        if not stat.S_ISREG(source_before.st_mode) or source_before.st_nlink != 1:
            fail("object source is not an unaliased regular file",
                 nlink=source_before.st_nlink)
        source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            expect(os.fstat(source_fd), expected_source, "opened object source")
            actual_sha256 = sha256_fd(source_fd)
            if actual_sha256 != expected_sha256:
                fail("object source bytes differ from expected identity",
                     expected=expected_sha256, actual=actual_sha256)
            tmp_fd = os.open(".", os.O_RDWR | os.O_TMPFILE, 0o600,
                             dir_fd=parent_fd)
            try:
                copy_fd(source_fd, tmp_fd)
                published = publish_tmp_fd(parent_fd, target_name, tmp_fd,
                                           expected_sha256, "candidate payload")
            finally:
                os.close(tmp_fd)
            try:
                source_retained = identity(os.lstat(source)) == expected_source
            except FileNotFoundError:
                source_retained = False
            expect_parent_path(parent, parent_fd, parent_identity,
                               "candidate payload")
            return {**published, "source_retained": source_retained,
                    "parent_identity": parent_identity}
        finally:
            os.close(source_fd)
    finally:
        os.close(parent_fd)


def validate_reference_envelopes(references):
    if not isinstance(references, list) or len(references) != len(FINALIZED_PAYLOAD_ROLES):
        fail("candidate manifest requires exactly two referenced payloads")
    normalized = []
    seen_roles = set()
    seen_names = set()
    for reference in references:
        if not isinstance(reference, dict) or set(reference) != REFERENCE_FIELDS:
            fail("candidate payload reference has an invalid envelope")
        role = reference["role"]
        name = reference["object_name"]
        digest = reference["sha256"]
        byte_count = reference["bytes"]
        if role not in FINALIZED_PAYLOAD_ROLES or role in seen_roles:
            fail("candidate payload reference has an invalid or duplicate role",
                 role=role)
        if (not isinstance(digest, str) or len(digest) != 64
                or any(character not in "0123456789abcdef" for character in digest)):
            fail("candidate payload reference SHA-256 is malformed", role=role)
        expected_name = f"schema-payload-{role}-{digest}.log"
        if name != expected_name or os.path.basename(name) != name or name in seen_names:
            fail("candidate payload reference has an invalid or duplicate name",
                 role=role, expected=expected_name, actual=name)
        if type(byte_count) is not int or byte_count < 0:
            fail("candidate payload reference byte count is invalid", role=role)
        seen_roles.add(role)
        seen_names.add(name)
        normalized.append({"role": role, "object_name": name,
                           "sha256": digest, "bytes": byte_count})
    if seen_roles != set(FINALIZED_PAYLOAD_ROLES):
        fail("candidate manifest payload roles are incomplete",
             actual=sorted(seen_roles))
    return sorted(normalized, key=lambda row: row["role"])


def open_manifest_reference(parent_fd, parent_identity, reference):
    name = reference["object_name"]
    before = lstat_at(parent_fd, name)
    if (not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or stat.S_IMODE(before.st_mode) != FINALIZED_FILE_MODE
            or before.st_uid != parent_identity["uid"]):
        fail("candidate manifest payload is not an immutable owned file",
             role=reference["role"], actual=file_state(before))
    sealed = file_state(before)
    if sealed["size"] != reference["bytes"]:
        fail("candidate manifest payload byte count differs",
             role=reference["role"], expected=reference["bytes"],
             actual=sealed["size"])
    payload_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        expect_file_state(os.fstat(payload_fd), sealed,
                          "opened candidate manifest payload")
        first_sha256 = sha256_fd(payload_fd)
        second_sha256 = sha256_fd(payload_fd)
        if first_sha256 != reference["sha256"] or second_sha256 != first_sha256:
            fail("candidate manifest payload bytes differ",
                 role=reference["role"], expected=reference["sha256"],
                 actual=first_sha256, second=second_sha256)
        expect_file_state(os.fstat(payload_fd), sealed,
                          "pinned candidate manifest payload")
        expect_file_state(lstat_at(parent_fd, name), sealed,
                          "named candidate manifest payload")
        return payload_fd, {**reference, "identity": identity(before),
                            "file_state": sealed}
    except BaseException:
        os.close(payload_fd)
        raise


def recheck_manifest_reference(parent_fd, opened):
    payload_fd, evidence = opened
    sealed = evidence["file_state"]
    expect_file_state(os.fstat(payload_fd), sealed,
                      "committed candidate manifest payload")
    actual_sha256 = sha256_fd(payload_fd)
    if actual_sha256 != evidence["sha256"]:
        fail("candidate manifest payload changed across publication",
             role=evidence["role"], expected=evidence["sha256"],
             actual=actual_sha256)
    expect_file_state(os.fstat(payload_fd), sealed,
                      "rehashed candidate manifest payload")
    expect_file_state(lstat_at(parent_fd, evidence["object_name"]), sealed,
                      "committed named candidate manifest payload")


def publish_manifest_object(parent, target_name, expected_sha256,
                            expected_parent, references):
    if not os.path.isabs(parent) or os.path.basename(target_name) != target_name:
        fail("manifest parent must be absolute and target must be one component")
    if len(expected_sha256) != 64:
        fail("manifest SHA-256 is malformed")
    references = validate_reference_envelopes(references)
    payload = sys.stdin.buffer.read(MAX_STDIN_OBJECT_BYTES + 1)
    if len(payload) > MAX_STDIN_OBJECT_BYTES:
        fail("manifest exceeds publication limit", limit=MAX_STDIN_OBJECT_BYTES)
    actual_sha256 = hashlib.sha256(payload).hexdigest()
    if actual_sha256 != expected_sha256:
        fail("manifest bytes differ from expected identity",
             expected=expected_sha256, actual=actual_sha256)
    parent_fd, parent_identity = open_pinned_parent(parent, "candidate manifest")
    opened_references = []
    try:
        lock_parent(parent_fd, True, "candidate manifest")
        if expected_parent is not None and parent_identity != expected_parent:
            fail("candidate manifest parent differs from reserved authority",
                 expected=expected_parent, actual=parent_identity)
        for reference in references:
            opened_references.append(
                open_manifest_reference(parent_fd, parent_identity, reference))
        expect_parent_path(parent, parent_fd, parent_identity,
                           "candidate manifest")
        tmp_fd = os.open(".", os.O_RDWR | os.O_TMPFILE, 0o600,
                         dir_fd=parent_fd)
        try:
            write_all(tmp_fd, payload)
            for opened in opened_references:
                recheck_manifest_reference(parent_fd, opened)
            published = publish_tmp_fd(parent_fd, target_name, tmp_fd,
                                       expected_sha256, "candidate manifest")
            for opened in opened_references:
                recheck_manifest_reference(parent_fd, opened)
            expect_parent_path(parent, parent_fd, parent_identity,
                               "candidate manifest")
            return {**published, "parent_identity": parent_identity,
                    "references": [opened[1] for opened in opened_references],
                    "cooperative_lock": "exclusive-parent-fd"}
        finally:
            os.close(tmp_fd)
    finally:
        for payload_fd, _evidence in opened_references:
            os.close(payload_fd)
        os.close(parent_fd)


def main(argv):
    if not argv:
        fail("an owned-file operation is required")
    operation, *args = argv
    required = {"dev", "ino", "uid", "mode", "kind"}
    if operation == "inspect-retained-stage" and len(args) == 5:
        parent, stage_name, kind, stage_json, marker_json = args
        expected_stage = json.loads(stage_json)
        expected_marker = json.loads(marker_json)
        if set(expected_stage) != required or set(expected_marker) != required:
            fail("identity envelopes must contain exactly dev/ino/uid/mode/kind")
        result = inspect_stage(parent, stage_name, kind, expected_stage, expected_marker)
    elif operation == "inspect-retained-file" and len(args) == 3:
        parent, name, expected_json = args
        expected = json.loads(expected_json)
        if set(expected) != required:
            fail("identity envelope must contain exactly dev/ino/uid/mode/kind")
        result = inspect_owned_file(parent, name, expected)
    elif operation == "publish-receipt" and len(args) == 6:
        (parent, stage_name, target_name, expected_json, expected_sha256,
         expected_parent_json) = args
        expected = json.loads(expected_json)
        expected_parent = json.loads(expected_parent_json)
        if set(expected) != required or set(expected_parent) != required:
            fail("identity envelopes must contain exactly dev/ino/uid/mode/kind")
        result = publish_receipt(parent, stage_name, target_name,
                                 expected, expected_sha256, expected_parent)
    elif operation == "read-object" and len(args) == 3:
        parent, name, expected_parent_json = args
        expected_parent = (None if expected_parent_json == "-" else
                           json.loads(expected_parent_json))
        if expected_parent is not None and set(expected_parent) != required:
            fail("parent identity envelope must contain exactly dev/ino/uid/mode/kind")
        evidence, payload = read_object(parent, name, expected_parent)
        header = json.dumps(evidence, sort_keys=True).encode("utf-8")
        sys.stdout.buffer.write(header + b"\n" + payload)
        return
    elif operation == "publish-file-object" and len(args) == 6:
        (parent, source, target_name, expected_json, expected_sha256,
         expected_parent_json) = args
        expected = json.loads(expected_json)
        expected_parent = json.loads(expected_parent_json)
        if set(expected) != required or set(expected_parent) != required:
            fail("identity envelopes must contain exactly dev/ino/uid/mode/kind")
        result = publish_file_object(parent, source, target_name,
                                     expected, expected_sha256, expected_parent)
    elif operation == "publish-manifest-object" and len(args) == 5:
        (parent, target_name, expected_sha256, expected_parent_json,
         references_json) = args
        expected_parent = json.loads(expected_parent_json)
        references = json.loads(references_json)
        if set(expected_parent) != required:
            fail("parent identity envelope must contain exactly dev/ino/uid/mode/kind")
        result = publish_manifest_object(parent, target_name, expected_sha256,
                                         expected_parent, references)
    else:
        fail("unsupported owned-file operation or argument count", operation=operation)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as error:
        message = str(error)
        if not message.startswith("{"):
            message = json.dumps({"ok": False, "error": message}, sort_keys=True)
        print(message, file=sys.stderr)
        sys.exit(1)
