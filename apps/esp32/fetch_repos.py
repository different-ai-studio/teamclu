import os
import subprocess
import json


def clone_or_update_repo(
    repo_url, path, ref=None, with_submodules=False, patch_path=None
):
    import os

    if not os.path.exists(path):
        subprocess.run(["git", "clone", repo_url, path], check=True)
    else:
        subprocess.run(["git", "-C", path, "fetch"], check=True)

    if ref:
        subprocess.run(["git", "-C", path, "checkout", ref], check=True)

    if with_submodules:
        subprocess.run(
            ["git", "-C", path, "submodule", "update", "--init", "--recursive"],
            check=True,
        )

    # 应用 patch
    if patch_path:
        patch_full_path = (
            patch_path
            if os.path.isabs(patch_path)
            else os.path.join(os.getcwd(), patch_path)
        )
        # 使用 git apply --check 先检测补丁是否能应用，避免报错
        check_result = subprocess.run(
            ["git", "-C", path, "apply", "--check", patch_full_path]
        )
        if check_result.returncode == 0:
            subprocess.run(["git", "-C", path, "apply", patch_full_path], check=True)
            print(f"Applied patch {patch_path} to {path}")
        else:
            # Fail, do not skip.
            #
            # Skipping produced a build that looks entirely healthy and is
            # missing half a feature: when the esp-wifi-connect patch stopped
            # applying, the provisioning portal lost its pairing-code field, the
            # firmware shipped without it, and the only trace was one line of
            # output above a successful `idf.py build`. Pairing then failed on
            # hardware with "pairing code missing" — a symptom two layers away
            # from the cause.
            #
            # A patch that no longer applies means upstream moved. That needs a
            # person to look, not a warning nobody reads.
            raise SystemExit(
                f"ERROR: patch {patch_path} no longer applies to {path}.\n"
                f"       Upstream has moved. Regenerate the patch against the "
                f"current checkout — do not build without it, the result will "
                f"be silently missing whatever the patch adds.\n"
                f"       Diagnose with: git -C {path} apply --check -v "
                f"{patch_full_path}"
            )


def fetch_dependencies():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    config_path = os.path.join(script_dir, "repos.json")

    with open(config_path) as f:
        repos = json.load(f)

    for repo in repos:
        repo_path = os.path.join(script_dir, repo["path"])
        branch = repo.get("branch")
        with_submodules = repo.get("with_submodules", False)
        patch = repo.get("patch")
        if patch and not os.path.isabs(patch):
            patch = os.path.join(script_dir, patch)
        clone_or_update_repo(repo["url"], repo_path, branch, with_submodules, patch)


if __name__ == "__main__":
    fetch_dependencies()