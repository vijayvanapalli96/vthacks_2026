# Vultr employer-agent deployment

The deployment runs the employer and applicant Node agents behind Caddy using
their ANS-issued certificates. No private key is committed.

1. Create an Ubuntu 24.04 Vultr instance with a public IPv4 address and paste
   `cloud-init.yaml` into its user-data field.
2. Wait for cloud-init to finish, then deploy from the repository root:

   ```powershell
   .\infra\vultr\deploy.ps1 -HostIp <PUBLIC_IPV4> -IdentityFile <SSH_PRIVATE_KEY>
   ```

3. In Porkbun DNS, add `A` records named `employer` and `applicant`, both pointing
   to the public IPv4 address. Keep the existing ANS HTTPS, TXT, badge, and TLSA records.
4. After DNS resolves, verify the public service:

   ```powershell
   .\infra\vultr\verify-public.ps1
   ```

Required public endpoints:

- `GET https://employer.hirewire.biz/health`
- `GET https://employer.hirewire.biz/.well-known/agent-card.json`
- `POST https://employer.hirewire.biz/a2a/apply`
- `GET https://applicant.hirewire.biz/health`
- `GET https://applicant.hirewire.biz/.well-known/agent-card.json`
- `POST https://applicant.hirewire.biz/a2a/apply`

The local `certs/` directory and generated `work/` archive remain gitignored.
