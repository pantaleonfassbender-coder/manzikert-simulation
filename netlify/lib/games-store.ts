import { getStore } from '@netlify/blobs';

const STORE_NAME = 'mantzikert-games';

export function getGamesStore() {
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;

  if (siteID && token) {
    return getStore({ name: STORE_NAME, siteID, token });
  }

  return getStore(STORE_NAME);
}
