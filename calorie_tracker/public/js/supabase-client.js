window.PulsePlate = window.PulsePlate || {};

window.PulsePlate.ready = (async () => {
  const response = await fetch('/api/config');
  const config = await response.json();
  if (!response.ok) throw new Error(config.error || 'Unable to load application configuration.');
  if (!window.supabase?.createClient) throw new Error('Supabase client library failed to load.');
  const client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
  window.PulsePlate.supabase = client;
  return client;
})();
