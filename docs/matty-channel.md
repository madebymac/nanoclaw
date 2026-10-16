# Matty channel

Lets the [Matty](https://github.com/madebymac/matty) app, running on the same
host, send a message to an agent and read the reply. Matty uses it for food
estimates (its Describe tab), so they run on the Claude subscription instead of
a metered API key.

`src/channels/matty.ts` listens on a Unix socket, `data/matty.sock`, `chmod 600`.
Only the owning user can connect, so there is no network port and no token. One
JSON object per line each way: `{"text": "..."}`. Replies go to the connection
that last sent a message. The agent can answer late or twice, so matching a
reply to its request is the client's job (Matty puts an id in the prompt and
checks it comes back).

## Wiring it (once per install)

The channel is registered at startup. Give it a dedicated agent group so
estimates don't share a session or context with your other agents:

```bash
ncl groups create --name matty-food --folder matty-food
ncl messaging-groups create --channel-type matty --platform-id app \
  --name "Matty app" --unknown-sender-policy public
ncl wirings create --messaging-group-id <mg-id> --agent-group-id <group-id> \
  --engage-mode pattern --engage-pattern .
```

`public` is safe here because the socket permissions already decide who can
send. The agent group needs no tools or custom `CLAUDE.md`: Matty sends the
instructions with each request.

Then point Matty at it: `MATTY_NANOCLAW_SOCKET=<nanoclaw>/data/matty.sock` in
Matty's `.env`, and restart Matty.

## Notes

- The socket is created when the host starts; restart the NanoClaw service
  after updating to a version that has this channel.
- Each estimate is a turn in the wired agent's session. Estimates are
  stateless, but the session grows over time; `/clear` it occasionally.
