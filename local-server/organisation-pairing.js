function normaliseDomain(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Enter your organisation’s Equip site URL.');
  const url = new URL(text.includes('://') ? text : `https://${text}`);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Use an HTTPS Equip site URL without credentials.');
  }
  return url.hostname.toLowerCase();
}

function createOrganisationPairing({ database, getApiBaseUrl, onPaired, fetchImpl = fetch }) {
  async function resolve(domain) {
    const hostname = normaliseDomain(domain);
    const base = getApiBaseUrl() || 'https://eqpd.co.nz';
    const response = await fetchImpl(`${base}/api/portal/organisation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationDomain: hostname }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.message || 'Organisation could not be found.');
      error.status = response.status;
      throw error;
    }
    if (!data.organizationDomain) throw new Error('The server did not return an organisation domain.');
    return { ...data, organizationDomain: normaliseDomain(data.organizationDomain) };
  }
  async function organisation(req, res) {
    try { return res.json(await resolve(req.query.domain)); }
    catch (error) { return res.status(error.status || 503).json({ message: error.message }); }
  }
  async function pair(req, res) {
    let domain;
    const code = String(req.body?.portalCode || '').trim().toUpperCase();
    try {
      domain = normaliseDomain(req.body?.organizationDomain);
      if (!/^[A-Z0-9]{8}$/.test(code)) return res.status(400).json({ message: 'Enter the 8-character portal code.' });
      const cachedDomain = database.getConfig('organizationDomain');
      const cachedCode = database.getConfig('pairingCode');
      if ((domain !== cachedDomain || code !== cachedCode) && database.getPendingCount() > 0) {
        return res.status(409).json({ message: 'Sync the pending offline transactions before changing organisation or portal.' });
      }
      const organisation = await resolve(domain);
      domain = organisation.organizationDomain;
      const base = `https://${domain}`;
      const response = await fetchImpl(`${base}/api/portal/pair`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portalCode: code, organizationDomain: domain }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);
      if (!data.token || !data.armoury?.id) throw new Error('The server returned an incomplete portal session.');
      const changesScope = domain !== cachedDomain || data.armoury.id !== database.getConfig('armouryId');
      if (changesScope && database.getPendingCount() > 0) {
        return res.status(409).json({ message: 'Sync pending offline transactions before changing portal.' });
      }
      database.getDb().transaction(() => {
        if (changesScope) {
          // These are synced LOCAL caches, never cloud records. Unsent
          // transactions are protected by the checks above.
          database.getDb().exec('DELETE FROM cached_movements; DELETE FROM equipment_transactions; DELETE FROM equipment; DELETE FROM users; DELETE FROM categories; DELETE FROM offline_queue; DELETE FROM portal_config;');
        }
        database.setConfig('token', data.token);
        database.setConfig('armouryId', data.armoury.id);
        database.setConfig('armouryName', data.armoury.name || '');
        database.setConfig('pairingCode', code);
        database.setConfig('organizationDomain', domain);
        database.setConfig('apiBaseUrl', base);
        database.setConfig('settings', JSON.stringify(data.settings || {}));
      })();
      onPaired(base, domain);
      return res.json({ ...data, organizationDomain: domain });
    } catch (error) {
      // Network-only offline recovery must match BOTH organisation and code.
      // A resolver rejection or invalid code must never authenticate a cache.
      const networkFailure = ['AbortError', 'TimeoutError'].includes(error.name) ||
        (error instanceof TypeError && /fetch|network|socket/i.test(error.message));
      if (networkFailure && !error.status && domain && domain === database.getConfig('organizationDomain') &&
          code === database.getConfig('pairingCode') && database.getConfig('token')) {
        return res.json({
          token: database.getConfig('token'), organizationDomain: domain,
          expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
          armoury: { id: database.getConfig('armouryId'), name: database.getConfig('armouryName') },
          settings: JSON.parse(database.getConfig('settings') || '{}'),
        });
      }
      return res.status(error.status || 503).json({ message: error.message || 'Cannot connect to your organisation.' });
    }
  }
  return { organisation, pair };
}
module.exports = { normaliseDomain, createOrganisationPairing };
