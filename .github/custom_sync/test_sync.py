import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class DescriptionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("sync", Path(__file__).with_name("sync.py"))
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_only_description_changes_and_is_idempotent(self):
        original = "---\nname: web-access\ndescription: >\n  upstream text\nmetadata:\n  version: '3'\n---\n# Body\ndescription: keep this body\n"
        updated = self.module.patch_description(original)
        self.assertEqual(updated.split("metadata:", 1)[1], original.split("metadata:", 1)[1])
        self.assertTrue(updated.startswith("---\nname: web-access\n"))
        self.assertIn("普通公开搜索", updated)
        self.assertEqual(self.module.patch_description(updated), updated)

    def test_inline_description(self):
        original = '---\nname: web-access\ndescription: "old"\n---\nbody\n'
        self.assertTrue(self.module.patch_description(original).endswith("---\nbody\n"))

    def test_rejects_missing_duplicate_or_broken_frontmatter(self):
        for text in ["body", "---\nname: x\n---\nbody", "---\ndescription: x\ndescription: y\n---\n", "---\ndescription: x\n"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                self.module.patch_description(text)

    def test_upstream_merge_retains_new_content_and_custom_description(self):
        source = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)

            def run(*args):
                return subprocess.run(args, cwd=root, check=True, capture_output=True)

            run("git", "init", "-b", "main")
            run("git", "config", "user.name", "Sync test")
            run("git", "config", "user.email", "sync-test@example.invalid")
            for path in [".github/custom_sync/sync.py", ".github/custom_sync/test_sync.py",
                         ".github/workflows/sync_upstream.yml", "FORK_SYNC.md"]:
                (root / path).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source / path, root / path)
            skill = root / "SKILL.md"
            skill.write_text("---\nname: web-access\ndescription: old\nmetadata:\n  version: '1'\n---\nold body\n", encoding="utf-8")
            run("git", "add", ".")
            run("git", "commit", "-m", "base")
            run("git", "switch", "-c", "upstream_fixture")
            skill.write_text("---\nname: web-access\ndescription: new upstream\nmetadata:\n  version: '2'\n---\nnew body\n", encoding="utf-8")
            (root / "new_upstream_file").write_text("new feature", encoding="utf-8")
            run("git", "add", ".")
            run("git", "commit", "-m", "upstream update")
            run("git", "switch", "main")
            run(sys.executable, "-B", ".github/custom_sync/sync.py", "--patch-only")
            run("git", "add", ".")
            run("git", "commit", "-m", "custom description")
            run(sys.executable, "-B", ".github/custom_sync/sync.py", "--upstream", "upstream_fixture")
            updated = skill.read_text(encoding="utf-8")
            self.assertIn("version: '2'", updated)
            self.assertTrue(updated.endswith("new body\n"))
            self.assertIn("普通公开搜索", updated)
            self.assertEqual((root / "new_upstream_file").read_text(), "new feature")
            run("git", "add", ".")
            run("git", "commit", "-m", "sync")
            run(sys.executable, "-B", ".github/custom_sync/sync.py", "--upstream", "upstream_fixture")
            self.assertEqual(run("git", "status", "--porcelain").stdout, b"")


if __name__ == "__main__":
    unittest.main()
