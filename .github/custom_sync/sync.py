"""Merge upstream history and reapply the fork's description without running upstream code."""

import argparse
from pathlib import Path
import re
import subprocess


DESCRIPTION = """description: >
  需要复用用户日常浏览器登录态、进行页面交互，或获取必须依赖浏览器渲染的
  内容时使用。适用于登录后访问、点击、填写、上传、页面内导航，以及明确
  要求通过用户浏览器完成的任务。普通公开搜索、静态网页读取、公开 API
  请求和无需浏览器登录态的下载不默认触发。
"""


def patch_description(text):
    header = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", text, re.S)
    if not header:
        raise ValueError("SKILL.md YAML frontmatter missing or malformed; refusing to edit")
    frontmatter = header.group(1)
    if len(re.findall(r"^description:", frontmatter, re.M)) != 1:
        raise ValueError("Expected exactly one top-level description in SKILL.md")
    pattern = r"^description:[^\r\n]*(?:\r?\n(?:[ \t]+[^\r\n]*|(?=\r?$)))*"
    newline = "\r\n" if "\r\n" in header.group(0) else "\n"
    replacement = DESCRIPTION.rstrip("\n").replace("\n", newline)
    updated, count = re.subn(pattern, lambda _: replacement, frontmatter, count=1, flags=re.M)
    if count != 1:
        raise ValueError("Unable to locate description safely")
    return text[:header.start(1)] + updated + text[header.end(1):]


def git(*args, capture=False):
    return subprocess.run(["git", *args], check=True, capture_output=capture).stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--patch-only", action="store_true")
    parser.add_argument("--upstream", default="refs/remotes/upstream/main")
    args = parser.parse_args()
    if not args.patch_only:
        if git("status", "--porcelain", capture=True).strip():
            raise RuntimeError("Working tree must be clean before synchronization")
        # Keep the trusted fork automation even if upstream introduces matching paths.
        protected = [
            ".github/workflows/sync_upstream.yml",
            ".github/custom_sync/sync.py",
            ".github/custom_sync/test_sync.py",
            "FORK_SYNC.md",
        ]
        saved = {path: git("show", "HEAD:" + path, capture=True) for path in protected}
        git("merge", "--no-commit", "--no-ff", "-X", "theirs", args.upstream)
        for path, contents in saved.items():
            target = Path(path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(contents)
    skill = Path("SKILL.md")
    original = skill.read_bytes().decode("utf-8")
    updated = patch_description(original)
    skill.write_bytes(updated.encode("utf-8"))
    if patch_description(updated) != updated:
        raise RuntimeError("Description patch is not idempotent")
    print("Custom description applied; other SKILL.md content preserved.")


if __name__ == "__main__":
    main()
