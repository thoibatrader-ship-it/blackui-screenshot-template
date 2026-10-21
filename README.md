# blackui-screenshot-template

Open-source GitHub Actions template that captures app screenshots from an HTML app.
Used by the BlackUI dashboard: it creates a private copy of this repo in the user's own GitHub account,
commits the user's HTML + `request.json` into `jobs/<app-name>/`, runs the **Capture Screenshots** workflow
(input `job` = the app folder name), and downloads the results (artifacts `shots-preview-<job>` and `shots-full-<job>`).

Mark this repository as a **Template repository** (Settings -> General) and keep it **public**.

Details: see `screenshot-tool/README.md`.
