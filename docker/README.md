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
repositories you want to review, as an absolute path:

```sh
REPOS=~/code docker compose -f docker/compose.yaml up -d --build
```

Open `http://<this machine's LAN address>:8080`. On macOS, the LAN address is
`ipconfig getifaddr en0`; on Linux, `hostname -I`.

| Setting | Default | Meaning |
|---|---|---|
| `REPOS` | required | An absolute path. It is mounted at the same path in the container, so a repository has one path, such as `/Users/you/code/my-service`, for agents on this machine and in the container. Only repositories under it can be reviewed. |
| `WHITEBOARD_PORT` | `8080` | The published port, or `address:port`. |
| `WHITEBOARD_UID`, `WHITEBOARD_GID` | `1000` | The user and group IDs reviews and agents run as, set when the image is built. On Linux, use your own: see [On Linux](#on-linux). |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | unset | Optional API keys for Ask's agents, instead of signing in. Compose passes them in whenever the shell that runs it has them set; unset them first if you do not want Ask to use them. |

The container is named `whiteboard`, so `docker exec whiteboard …` reaches it
without the compose file.

Two volumes keep state across `docker compose down` and `up`:

- `whiteboard-data` (`/data`) holds the reviews, Ask threads, viewed state and
  the checkouts Whiteboard prepares for Ask.
- `agent-home` (`/home/node`) holds the agents' sign-ins and settings.

`docker compose down -v` deletes both.

## Sign the agents in

Ask runs Claude Code, Codex, OpenCode and GitHub Copilot CLI inside the
container. Sign in to the ones you use once; the sign-ins stay in the
`agent-home` volume:

```sh
docker exec -it whiteboard claude   # then /login
docker exec -it whiteboard codex login --device-auth
docker exec -it whiteboard opencode auth login
docker exec -it whiteboard copilot login
```

Credentials on your own machine are not used: on macOS, Claude Code keeps them
in the Keychain, which a container cannot read. Without a sign-in or an API
key, Whiteboard still serves reviews, and Ask says the agent is not signed in.

## Make a review

Reviews are authored by a coding agent connected to Whiteboard's MCP server.
The review appears in the browser as soon as the agent creates it.

### With an agent on this machine

Register the container's MCP server with the agent once. `docker exec` runs
`whiteboard mcp` inside the container: the same server Desktop's plugin
starts, always the version this container serves. It is named
`whiteboard-docker` so it can sit beside a Desktop connection.

```sh
claude mcp add --scope user whiteboard-docker -- docker exec -i whiteboard whiteboard mcp
codex mcp add whiteboard-docker -- docker exec -i whiteboard whiteboard mcp
copilot mcp add whiteboard-docker -- docker exec -i whiteboard whiteboard mcp
```

For OpenCode, add it to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "whiteboard-docker": {
      "type": "local",
      "command": ["docker", "exec", "-i", "whiteboard", "whiteboard", "mcp"]
    }
  }
}
```

Then work in a repository under `REPOS` and ask for a whiteboard of your
change. If the agent is also connected to Whiteboard Desktop, say which to
use, for example "make a whiteboard with whiteboard-docker". Start the
container before the agent; an agent that starts first reports that the
server failed, and needs its MCP servers reloaded.

The CLI works the same way, for example
`docker exec whiteboard whiteboard api session_list`.

### With an agent in the container

Start the agent in a mounted repository, at its path on this machine, and
register Whiteboard's MCP server with it once:

```sh
docker exec -it -w ~/code/my-service whiteboard claude
```

```sh
docker exec whiteboard claude mcp add --scope user whiteboard -- whiteboard mcp
docker exec whiteboard codex mcp add whiteboard -- whiteboard mcp
docker exec whiteboard copilot mcp add whiteboard -- whiteboard mcp
```

For OpenCode in the container, use the configuration above with
`"command": ["whiteboard", "mcp"]`, in `/home/node/.config/opencode/opencode.json`.
`whiteboard connect` does not apply here: it installs a plugin that starts
Desktop's `whiteboard` command. The image sets `DEV_REVIEW_SERVER_DIR`, so
every `whiteboard` command in the container uses this server.

## On Linux

Docker Engine keeps the owners of the files you mount, so the container's user
must have your user and group IDs. Otherwise it cannot write the review
checkouts Whiteboard keeps in each repository's `.git`, and git refuses the
repositories as having "dubious ownership". Build with your IDs:

```sh
WHITEBOARD_UID=$(id -u) WHITEBOARD_GID=$(id -g) REPOS=$HOME/code \
  docker compose -f docker/compose.yaml up -d --build
```

Docker Desktop on macOS and Windows maps owners itself; leave these unset
there. Volumes made by a build with other IDs keep their old owner; hand them
to the new IDs once:

```sh
WHITEBOARD_UID=$(id -u) WHITEBOARD_GID=$(id -g) REPOS=$HOME/code \
  docker compose -f docker/compose.yaml run --rm -u root --entrypoint chown \
  whiteboard -R "$(id -u):$(id -g)" /data /home/node
```

Also on Linux:

- Docker publishes ports past `ufw` and other firewall rules. On a machine
  with a public address, publish on its LAN address only, for example
  `WHITEBOARD_PORT=192.168.1.50:8080`.
- Agents on the machine reach the container with `docker exec`, so your user
  needs to be in the `docker` group (`sudo usermod -aG docker $USER`, then log
  in again). That group is equivalent to root on the machine.

## What differs from Whiteboard Desktop

- No hover, go to definition or other language features in code.
- No Source tree window, settings page, onboarding or tutorial.
- Changes to uncommitted files show when the review updates, not as you type.
- The interface follows the browser's light or dark setting.
- Software maps are switched on when the server starts, by `--software-maps`
  in the `CMD` of `docker/Dockerfile`, not in Settings. Drop the flag to turn
  them off.
- Structural diff is always on; there is no setting to switch to the line diff.
- Agents cannot show a review in a window: `session_open` reports that no
  Desktop is attached. Reviews appear in the browser's Home list instead.
- No scratchpad.
