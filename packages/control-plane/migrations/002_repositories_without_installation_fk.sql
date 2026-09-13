-- Repositories are learned from push webhooks and installation sync even when
-- the installation.created webhook was missed, so a repository must not
-- require its installation row. deleteInstallation removes repositories
-- explicitly instead of via cascade.
ALTER TABLE repositories DROP CONSTRAINT IF EXISTS repositories_installation_id_fkey;
