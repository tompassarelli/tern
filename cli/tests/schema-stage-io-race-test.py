#!/usr/bin/env python3
"""Deterministic replacement-race probes for the Linux schema FD boundary."""

import hashlib
import importlib.util
import fcntl
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import threading


HELPER_PATH = Path(__file__).resolve().parents[1] / "schema-stage-io.py"
SPEC = importlib.util.spec_from_file_location("north_schema_stage_io", HELPER_PATH)
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


def check(label, condition, detail=None):
    if not condition:
        raise AssertionError(f"{label}: {detail!r}")
    print(f"  [PASS] {label}")


def file_identity(path):
    return HELPER.identity(os.lstat(path))


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class BinaryStdin:
    def __init__(self, payload):
        self.buffer = io.BytesIO(payload)


def manifest_fixture(parent):
    references = []
    for role, payload in (("coordination", b"COORDINATION\n"),
                          ("telemetry", b"TELEMETRY\n")):
        digest = hashlib.sha256(payload).hexdigest()
        name = f"schema-payload-{role}-{digest}.log"
        path = Path(parent) / name
        path.write_bytes(payload)
        os.chmod(path, 0o444)
        references.append({"role": role, "object_name": name,
                           "sha256": digest, "bytes": len(payload)})
    manifest = b'{:format "race-fixture/v1"}\n'
    target = f"schema-candidate-{'a' * 64}.edn"
    return references, manifest, target


def publish_manifest(parent, references, manifest, target):
    original_stdin = HELPER.sys.stdin
    HELPER.sys.stdin = BinaryStdin(manifest)
    try:
        return HELPER.publish_manifest_object(
            parent, target, hashlib.sha256(manifest).hexdigest(),
            HELPER.identity(os.lstat(parent)), references)
    finally:
        HELPER.sys.stdin = original_stdin


def test_retained_file_replacement():
    with tempfile.TemporaryDirectory(prefix="north-schema-retain-race-") as parent:
        owned = Path(parent) / "owned"
        displaced = Path(parent) / "displaced"
        owned.write_bytes(b"ORIGINAL\n")
        expected = file_identity(owned)
        original_expect = HELPER.expect
        calls = 0

        def replace_after_first_check(actual, wanted, label):
            nonlocal calls
            result = original_expect(actual, wanted, label)
            calls += 1
            if calls == 1:
                owned.rename(displaced)
                owned.write_bytes(b"REPLACEMENT\n")
            return result

        HELPER.expect = replace_after_first_check
        denied = False
        try:
            HELPER.inspect_owned_file(parent, "owned", expected)
        except RuntimeError:
            denied = True
        finally:
            HELPER.expect = original_expect

        check("forced retained-file replacement is refused", denied)
        check("replacement inode is never deleted", owned.read_bytes() == b"REPLACEMENT\n")
        check("displaced owned inode is never deleted", displaced.read_bytes() == b"ORIGINAL\n")


def test_pinned_receipt_source_replacement():
    with tempfile.TemporaryDirectory(prefix="north-schema-receipt-race-") as parent:
        stage = Path(parent) / "stage"
        displaced = Path(parent) / "displaced"
        target = Path(parent) / "target"
        stage.write_bytes(b"PINNED-GOOD\n")
        expected = file_identity(stage)
        expected_sha = sha256(stage)
        original_link_fd = HELPER.link_fd

        def replace_before_publication(fd, parent_fd, name):
            stage.rename(displaced)
            stage.write_bytes(b"REPLACEMENT-BAD\n")
            return original_link_fd(fd, parent_fd, name)

        HELPER.link_fd = replace_before_publication
        try:
            result = HELPER.publish_receipt(parent, "stage", "target",
                                            expected, expected_sha)
        finally:
            HELPER.link_fd = original_link_fd

        target_stat = os.lstat(target)
        check("publication succeeds from the pinned source FD", result["ok"] is True)
        check("forced source replacement cannot poison target bytes",
              target.read_bytes() == b"PINNED-GOOD\n")
        check("published receipt is immutable and unaliased",
              stat.S_IMODE(target_stat.st_mode) == 0o444 and target_stat.st_nlink == 1)
        check("source replacement is retained untouched",
              stage.read_bytes() == b"REPLACEMENT-BAD\n")
        check("displaced pinned source is retained untouched",
              displaced.read_bytes() == b"PINNED-GOOD\n")


def test_wrong_existing_target_refused():
    with tempfile.TemporaryDirectory(prefix="north-schema-receipt-collision-") as parent:
        stage = Path(parent) / "stage"
        target = Path(parent) / "target"
        stage.write_bytes(b"EXPECTED\n")
        target.write_bytes(b"WRONG\n")
        os.chmod(target, 0o444)
        expected = file_identity(stage)
        before = target.read_bytes()
        denied = False
        try:
            HELPER.publish_receipt(parent, "stage", "target",
                                   expected, sha256(stage))
        except RuntimeError:
            denied = True
        check("wrong pre-existing target is refused", denied)
        check("wrong pre-existing target is never replaced or deleted",
              target.read_bytes() == before)


def test_parent_path_replacement_refused():
    with tempfile.TemporaryDirectory(prefix="north-schema-parent-race-") as root:
        parent = Path(root) / "store"
        displaced = Path(root) / "displaced-store"
        parent.mkdir()
        stage = parent / "stage"
        stage.write_bytes(b"PINNED-PARENT\n")
        expected = file_identity(stage)
        expected_sha = sha256(stage)
        original_link_fd = HELPER.link_fd

        def replace_parent_before_publication(fd, parent_fd, name):
            parent.rename(displaced)
            parent.mkdir()
            return original_link_fd(fd, parent_fd, name)

        HELPER.link_fd = replace_parent_before_publication
        denied = False
        try:
            HELPER.publish_receipt(str(parent), "stage", "target",
                                   expected, expected_sha)
        except RuntimeError:
            denied = True
        finally:
            HELPER.link_fd = original_link_fd

        check("forced parent-path replacement is refused", denied)
        check("decoy parent never receives an authoritative target",
              not (parent / "target").exists())
        check("exact bytes remain only in the displaced pinned parent",
              (displaced / "target").read_bytes() == b"PINNED-PARENT\n")


def test_pinned_reader_representation():
    with tempfile.TemporaryDirectory(prefix="north-schema-reader-race-") as parent:
        target = Path(parent) / "target"
        displaced = Path(parent) / "displaced"
        target.write_bytes(b"PINNED-READER\n")
        os.chmod(target, 0o444)
        evidence, payload = HELPER.read_object(parent, "target")
        check("pinned reader returns bytes from its validated descriptor",
              evidence["ok"] is True and payload == b"PINNED-READER\n")

        original_expect = HELPER.expect_file_state
        calls = 0

        def replace_after_open(actual, wanted, label):
            nonlocal calls
            result = original_expect(actual, wanted, label)
            calls += 1
            if calls == 1:
                target.rename(displaced)
                target.write_bytes(b"REPLACEMENT-READER\n")
                os.chmod(target, 0o444)
            return result

        HELPER.expect_file_state = replace_after_open
        denied = False
        try:
            HELPER.read_object(parent, "target")
        except RuntimeError:
            denied = True
        finally:
            HELPER.expect_file_state = original_expect

        check("reader refuses pathname replacement after descriptor open", denied)
        check("reader replacement inode remains untouched",
              target.read_bytes() == b"REPLACEMENT-READER\n")
        check("reader pinned inode remains untouched",
              displaced.read_bytes() == b"PINNED-READER\n")


def test_pinned_reader_link_and_parent_binding():
    with tempfile.TemporaryDirectory(prefix="north-schema-reader-link-") as root:
        parent = Path(root) / "store"
        other = Path(root) / "other"
        parent.mkdir()
        other.mkdir()
        target = parent / "target"
        alias = parent / "alias"
        target.write_bytes(b"LINK-COUNT\n")
        os.chmod(target, 0o444)
        original_bytes_fd = HELPER.bytes_fd
        calls = 0

        def link_during_read(fd):
            nonlocal calls
            calls += 1
            payload = original_bytes_fd(fd)
            if calls == 1:
                os.link(target, alias)
            return payload

        HELPER.bytes_fd = link_during_read
        denied_link = False
        try:
            HELPER.read_object(str(parent), "target")
        except RuntimeError:
            denied_link = True
        finally:
            HELPER.bytes_fd = original_bytes_fd
        check("reader refuses link-count drift while descriptor is pinned",
              denied_link)

        other_target = other / "target"
        other_target.write_bytes(b"OTHER-PARENT\n")
        os.chmod(other_target, 0o444)
        denied_parent = False
        try:
            HELPER.read_object(str(other), "target",
                               HELPER.identity(os.lstat(parent)))
        except RuntimeError:
            denied_parent = True
        check("reader refuses a different parent than reserved", denied_parent)

        receipt_stage = other / "receipt-stage"
        receipt_stage.write_bytes(b"RECEIPT-PARENT\n")
        denied_receipt_parent = False
        try:
            HELPER.publish_receipt(
                str(other), "receipt-stage", "receipt-target",
                file_identity(receipt_stage), sha256(receipt_stage),
                HELPER.identity(os.lstat(parent)))
        except RuntimeError:
            denied_receipt_parent = True
        check("receipt publisher refuses a different parent than reserved",
              denied_receipt_parent)
        check("wrong receipt parent receives no target",
              not (other / "receipt-target").exists())


def test_manifest_publication_lock_and_reference_transaction():
    with tempfile.TemporaryDirectory(prefix="north-schema-manifest-lock-") as parent:
        references, manifest, target = manifest_fixture(parent)
        held_parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        fcntl.flock(held_parent_fd, fcntl.LOCK_SH)
        attempting = threading.Event()
        finished = threading.Event()
        result = {}
        original_lock_parent = HELPER.lock_parent

        def observed_lock(parent_fd, exclusive, label):
            if label == "candidate manifest":
                attempting.set()
            return original_lock_parent(parent_fd, exclusive, label)

        def worker():
            try:
                result["value"] = publish_manifest(
                    parent, references, manifest, target)
            except BaseException as error:
                result["error"] = error
            finally:
                finished.set()

        HELPER.lock_parent = observed_lock
        thread = threading.Thread(target=worker, daemon=True)
        try:
            thread.start()
            reached_lock = attempting.wait(2)
            remained_blocked = reached_lock and not finished.wait(0.1)
        finally:
            fcntl.flock(held_parent_fd, fcntl.LOCK_UN)
            os.close(held_parent_fd)
        thread.join(5)
        HELPER.lock_parent = original_lock_parent

        check("manifest publication waits on the cooperative parent lock",
              remained_blocked)
        check("manifest publication completes after cooperative lock release",
              not thread.is_alive() and "error" not in result,
              result.get("error"))
        published = result.get("value", {})
        check("one locked operation binds both payloads before manifest authority",
              (published.get("cooperative_lock") == "exclusive-parent-fd"
               and len(published.get("references", [])) == 2
               and (Path(parent) / target).read_bytes() == manifest))


def test_manifest_post_link_reference_replacement_refused():
    with tempfile.TemporaryDirectory(prefix="north-schema-manifest-race-") as parent:
        references, manifest, target = manifest_fixture(parent)
        payload = Path(parent) / references[0]["object_name"]
        displaced = Path(parent) / "displaced-payload"
        original_link_fd = HELPER.link_fd

        def replace_reference_during_link(fd, parent_fd, name):
            payload.rename(displaced)
            payload.write_bytes(b"REPLACEMENT\n")
            os.chmod(payload, 0o444)
            return original_link_fd(fd, parent_fd, name)

        HELPER.link_fd = replace_reference_during_link
        denied = False
        try:
            publish_manifest(parent, references, manifest, target)
        except RuntimeError:
            denied = True
        finally:
            HELPER.link_fd = original_link_fd

        check("payload replacement across manifest link is refused", denied)
        check("post-link refusal never mutates either payload inode",
              (payload.read_bytes() == b"REPLACEMENT\n"
               and displaced.read_bytes() == b"COORDINATION\n"))
        check("a raced manifest pathname is not reported as authority",
              (Path(parent) / target).exists() and denied)


def test_no_pathname_deletion_primitives():
    source = HELPER_PATH.read_text(encoding="utf-8")
    check("stage IO boundary contains no pathname unlink",
          "os.unlink(" not in source and "os.remove(" not in source)
    check("stage IO boundary contains no pathname directory removal",
          "os.rmdir(" not in source)
    check("receipt publication never links from the source name",
          "os.link(" not in source and "AT_EMPTY_PATH" in source)


if __name__ == "__main__":
    test_retained_file_replacement()
    test_pinned_receipt_source_replacement()
    test_wrong_existing_target_refused()
    test_parent_path_replacement_refused()
    test_pinned_reader_representation()
    test_pinned_reader_link_and_parent_binding()
    test_manifest_publication_lock_and_reference_transaction()
    test_manifest_post_link_reference_replacement_refused()
    test_no_pathname_deletion_primitives()
    print("\nschema stage IO replacement races: 30 / 30 PASS")
