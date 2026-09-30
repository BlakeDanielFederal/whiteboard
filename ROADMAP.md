# Roadmap

## Next few weeks

- Continue fixing issues raised on [GitHub](https://github.com/devdotfast/whiteboard/issues) and [Discord](https://discord.gg/wYvd2cpMQg). Keep the feedback coming!
- Reintroduce commenting.
  - Leave comments on a whiteboard and get answers from the authoring agent inline, like you're reviewing your intern's PRs again.
  - We used to have this but thought people wouldn't want it. We were wrong!
- Rework the UI so you can plan and write specs in Whiteboard.
  - Code with your agent of choice, then review the code alongside the original spec in Whiteboard.
  - Give the UI a general facelift, potentially bringing back a left navigation bar like VS Code's.
  - Include support for multiple repositories.
- Ship an MVP of remote access over SSH.
  - Package the Whiteboard server with the VS Code LSP host so you can install it on a server as a single binary.
  - Make the UI a shell for local and remote reviews. Both should look and behave the same way and coexist.
- Push some Whiteboard state back to GitHub, including approving and merging PRs.
- Send notifications when whiteboards are done.
- Open files in an external editor.

## End of year (existential)

- Hosted diffr — [get in touch](https://dev.fast/get-in-touch/).
  - Sync state back to GitHub, with diffs that are actually readable.
- Hosted Whiteboard — [get in touch](https://dev.fast/get-in-touch/).
  - Automatically generate whiteboards for PRs.
  - Make sharing and commenting easy between you, your coworkers, and the authoring agent.
- Stay focused on solving code review for you folks.
  - We won't incorporate ADE-type features.
  - We won't have opinions about where you like to write your code.
  - Do one thing well: help you understand code you've written or plan to write.
