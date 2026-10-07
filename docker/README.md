# Whiteboard web in Docker

A personal Whiteboard that runs on one machine and opens in a browser on any
device on the same network. It serves the review canvas, diagrams, code peeks,
the Diff view and Ask from `whiteboard web`.

## It has no authentication

Anyone who can reach the port can read every review, and can run Ask agents,
with this container's agent sign-ins, in the repositories you mount. That is
equivalent to running code on this machine. Run it only on a network you
trust, such as your home network:

- Do not publish the port to the internet, forward it on your router, or
  expose it through a tunnel.
- Do not run it on shared networks (an office, a café, a hotel).
- To limit it to one device on the machine itself, publish it on loopback:
  `WHITEBOARD_PORT=127.0.0.1:8080`.

## Start it

From the repository root, with `REPOS` naming the directory that holds the git
repositories you want to review:

```sh
REPOS=~/code docker compose -f docker/compose.yaml up -d --build
```

Open `http://<this machine's LAN address>:8080`. On macOS, the LAN address is
`ipconfig getifaddr en0`; on Linux, `hostname -I`.

| Setting | Default | Meaning |
|---|---|---|
| `REPOS` | required | Mounted at `/repos`. Reviews refer to repositories by their path in the container, such as `/repos/my-service`. |
| `WHITEBOARD_PORT` | `8080` | The published port, or `address:port`. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | unset | Optional API keys for Ask's agents, instead of signing in. |

Two volumes keep state across `docker compose down` and `up`:

- `whiteboard-data` (`/data`) holds the reviews, Ask threads, viewed state and
  the checkouts Whiteboard prepares for Ask.
- `agent-home` (`/home/node`) holds the agents' sign-ins and settings.

`docker compose down -v` deletes both.

## Sign the agents in

Ask runs Claude Code, Codex and OpenCode inside the container. Sign each in once; the
sign-in stays in the `agent-home` volume:

```sh
docker compose -f docker/compose.yaml exec -it whiteboard claude   # then /login
docker compose -f docker/compose.yaml exec -it whiteboard codex login --device-auth
docker compose -f docker/compose.yaml exec -it whiteboard opencode auth login
```

Credentials on your own machine are not used: on macOS, Claude Code keeps them
in the Keychain, which a container cannot read. Without a sign-in or an API
key, Whiteboard still serves reviews, and Ask says the agent is not signed in.

## Make a review

Reviews are authored by a coding agent connected to Whiteboard. Start one in
the container, in a mounted repository, and connect it once:

```sh
docker compose -f docker/compose.yaml exec -it -w /repos/my-service whiteboard claude
```

In the agent, paste the output of `whiteboard connect claude` (run it in the
container), then ask for a whiteboard of your change. The agent's Whiteboard
tools reach this server: the image sets `DEV_REVIEW_SERVER_DIR` so every
`whiteboard` command in the container uses it. The review appears in the
browser as soon as it is created.

## What differs from Whiteboard Desktop

- No hover, go to definition or other language features in code.
- No Source tree window, settings page, onboarding or tutorial.
- Changes to uncommitted files show when the review updates, not as you type.
- The interface follows the browser's light or dark setting.
