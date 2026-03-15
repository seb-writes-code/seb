# load-ssh-key

Load an SSH private key from 1Password into the container so you can SSH into remote servers.

## When to use

Use this skill whenever you need SSH access — connecting to VMs, deploying code, managing servers, etc. Run it once per session before your first SSH command.

## Steps

1. Look up the SSH key item in 1Password:

```
Use mcp__1password__vault_list to find the vault ID for "Seb"
Use mcp__1password__item_lookup with that vault ID and query "agent-ssh-key"
```

2. Read the private key field:

```
Use mcp__1password__password_read with the vault ID and item ID, field: "private-key"
```

3. Read the public key field:

```
Use mcp__1password__password_read with the vault ID and item ID, field: "public-key"
```

4. Write the keys to disk and set permissions:

```bash
mkdir -p ~/.ssh
# Write the private key (use the Write tool, NOT echo/bash to avoid leaking key material in logs)
# File: ~/.ssh/id_ed25519
# Permissions: 600
chmod 600 ~/.ssh/id_ed25519

# Write the public key
# File: ~/.ssh/id_ed25519.pub
# Permissions: 644
chmod 644 ~/.ssh/id_ed25519.pub
```

5. Add common hosts to known_hosts:

```bash
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null
```

6. Verify:

```bash
ssh -T git@github.com 2>&1 || true
```

## Important

- **Never** log or echo the private key contents — use the Write tool to write it directly to the file
- **Never** store key material in plaintext files outside `~/.ssh/`
- The key is ephemeral — it only exists for the duration of this container session
- If the 1Password item `agent-ssh-key` doesn't exist, inform the user and skip gracefully

## Setting Up the SSH Key (for Chris)

To enable SSH access for Seb:

1. Generate an Ed25519 keypair:
   ```bash
   ssh-keygen -t ed25519 -C "seb@chrisraible.com" -f /tmp/agent-ssh-key
   ```

2. Store in 1Password vault "Seb":
   - Create a new item titled `agent-ssh-key`
   - Add a field `private-key` (type: concealed/password) with the contents of `/tmp/agent-ssh-key`
   - Add a field `public-key` (type: text) with the contents of `/tmp/agent-ssh-key.pub`

3. Add the public key to target VMs:
   ```bash
   ssh-copy-id -i /tmp/agent-ssh-key.pub user@your-server
   ```
   Or for Hetzner Cloud servers, add it via `hcloud ssh-key create`.

4. Clean up the local files:
   ```bash
   rm /tmp/agent-ssh-key /tmp/agent-ssh-key.pub
   ```
