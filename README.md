# PBIs for Herdr

A Herdr layout with a side panel that shows the Azure DevOps PBIs of the project linked to each space. Each PBI is a card. A card opens the work item, or starts a Claude Code agent on it.

![PBIs](preview.png)

## Install

Ask your agent in Herdr:

> Add the layout from https://github.com/JellyPuddingPie/Herdr-Azure-Devops-Integration

Or copy the files by hand:

1. Copy `layouts/main-pbis.json` to `~/.config/herdr-app/layouts/`.
2. Copy `mods/pbis` and `mods/tabs-pbis` to `~/.config/herdr-app/mods/`.
3. Run `herdr-app check ~/.config/herdr-app/mods/pbis` and `herdr-app check ~/.config/herdr-app/mods/tabs-pbis`.
4. Switch to the layout: `herdr-app do layout.switch --name main-pbis`, or press `Ctrl+Shift+L`.

## Use

1. Select a space and click **PBIs** in the tab bar.
2. Type the Azure DevOps organization name (or its URL) and click **Connect**.
3. The first time for an organization's tenant, click **Sign in with Microsoft**. Enter the code on the Microsoft page and pick the account that has access.
4. Pick the project. The space is now linked to it.

**Assigned to me** shows only your items. **Unlink** removes the link of the space.

## What it reaches

- `login.microsoftonline.com`, to sign in (device code flow, Microsoft's public client for Visual Studio).
- `dev.azure.com`, to read projects and work items. It never writes to Azure DevOps.
- It runs `curl` once per organization to find the organization's tenant.
- It keeps your space links and your sign-ins in `~/.config/herdr-app/data/`. The sign-in file holds refresh tokens: keep it private.

## Limits

- Shows work item types Product Backlog Item and User Story that are not Done, Removed or Closed. At most 200.
- `tabs-pbis` is a copy of Herdr's tab bar. It does not get Herdr's later changes to the tab bar.
