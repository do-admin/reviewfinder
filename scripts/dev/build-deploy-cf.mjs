#!/usr/bin/env node

/**
 * Cloudflare Build and Deploy Script for Astro
 *
 * Deploys sites to R2 and sets up routing via KV and Worker routes.
 *
 * Adapted for Astro from Herokit template.
 *
 * Usage:
 *   pnpm deploy:cf [options] [product-ids...]
 */

import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
import { copyLlmTxtToPublic } from '../lib/copy-llm-txt-to-public.mjs';
import { copyClientFaviconToPublic } from '../lib/copy-client-favicon-to-public.mjs';
// Removed addCssPreloads import - it was causing FOUC by making CSS async
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createReadStream } from 'fs';
import { tmpdir } from 'os';
import * as http from 'http';
import * as https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env.local and .env
const projectRoot = path.resolve(__dirname, '../../');
dotenv.config({ path: path.join(projectRoot, '.env.local'), quiet: true });
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

// Configuration
const HERO_SITES_DOMAIN = 'hero-pages.com';
const R2_BUCKET_NAME = process.env.CLOUDFLARE_R2_BUCKET_NAME || 'herokit-sites';
const WORKER_NAME =
  process.env.CLOUDFLARE_WORKER_NAME || 'herokit-static-router';

// Ensure R2_BUCKET_NAME is set in environment for R2Deployer
if (!process.env.CLOUDFLARE_R2_BUCKET_NAME) {
  process.env.CLOUDFLARE_R2_BUCKET_NAME = R2_BUCKET_NAME;
}

// ============================================================================
// R2 Deployer (inlined from r2-deployer.ts)
// ============================================================================

const R2_ACCOUNT_ID = process.env.CLOUDFLARE_R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT = process.env.CLOUDFLARE_R2_ENDPOINT;

// Initialize S3 client for R2 (R2 is S3-compatible)
let s3Client = null;

function getS3Client() {
  if (!s3Client) {
    if (
      !R2_ACCOUNT_ID ||
      !R2_ACCESS_KEY_ID ||
      !R2_SECRET_ACCESS_KEY ||
      !R2_ENDPOINT
    ) {
      throw new Error(
        'Cloudflare R2 credentials not configured. Please set CLOUDFLARE_R2_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY, and CLOUDFLARE_R2_ENDPOINT environment variables.'
      );
    }

    // Create HTTP agents with keepAlive for connection reuse (major performance boost)
    const httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 200,
      maxFreeSockets: 50,
    });

    const httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 200,
      maxFreeSockets: 50,
    });

    // Configure HTTP handler with optimized settings
    const requestHandler = new NodeHttpHandler({
      httpAgent,
      httpsAgent,
      socketAcquisitionWarningTimeout: 180000, // 3 minutes
      connectionTimeout: 10000, // 10 seconds
      requestTimeout: 180000, // 3 minutes for very large files
    });

    s3Client = new S3Client({
      region: 'auto', // R2 uses 'auto' region
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
      requestHandler,
      maxAttempts: 2, // Reduced to 2 for speed (we handle retries manually)
    });
  }

  return s3Client;
}

/**
 * Get MIME type from file extension (no I/O needed)
 */
function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.ico': 'image/x-icon',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Get all files recursively from a directory
 */
async function getAllFiles(dirPath, basePath = dirPath) {
  const files = [];
  const { readdir } = await import('fs/promises');
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(basePath, fullPath);

    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(fullPath, basePath);
      files.push(...subFiles);
    } else {
      files.push(relativePath);
    }
  }

  return files;
}

/**
 * Process items with concurrency control
 */
async function processWithConcurrency(items, concurrency, processor) {
  const results = new Array(items.length);
  let currentIndex = 0;
  let completed = 0;
  const total = items.length;
  const startTime = Date.now();

  const workers = [];

  for (let i = 0; i < concurrency; i++) {
    workers.push(
      (async () => {
        while (currentIndex < total) {
          const index = currentIndex++;
          const item = items[index];
          try {
            const result = await processor(item, index);
            results[index] = result;
            completed++;

            if (completed % 500 === 0 || completed === total) {
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
              const rate = (
                completed /
                ((Date.now() - startTime) / 1000)
              ).toFixed(1);
              console.log(
                `[R2 Deploy] Progress: ${completed}/${total} files (${Math.round((completed / total) * 100)}%) | ${rate} files/sec | ${elapsed}s elapsed`
              );
            }
          } catch (error) {
            throw error;
          }
        }
      })()
    );
  }

  await Promise.all(workers);
  return results;
}

class R2Deployer {
  isRcloneAvailable() {
    try {
      execSync('rclone version', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  async deployWithRclone(options) {
    const { siteId, sitePath, environment, deployId } = options;
    const r2Prefix = `sites/${siteId}/${deployId}`;

    if (!fs.existsSync(sitePath)) {
      return {
        success: false,
        error: `Site path does not exist: ${sitePath}`,
      };
    }

    const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID;
    const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
    const bucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME || 'herokit-sites';
    const endpoint = process.env.CLOUDFLARE_R2_ENDPOINT;

    if (!accountId || !accessKeyId || !secretAccessKey || !endpoint) {
      return {
        success: false,
        error: 'R2 credentials not configured',
      };
    }

    const configPath = path.join(
      tmpdir(),
      `rclone-${Date.now()}-${Math.random().toString(36).substring(7)}.conf`
    );

    try {
      const configContent = `[r2-temp]
type = s3
provider = Cloudflare
access_key_id = ${accessKeyId}
secret_access_key = ${secretAccessKey}
endpoint = ${endpoint}
region = auto
`;
      fs.writeFileSync(configPath, configContent, { mode: 0o600 });

      const files = await getAllFiles(sitePath, sitePath);
      console.log(
        `[R2 Deploy] 🚀 Using rclone sync to upload ${files.length} files...`
      );

      const r2Path = `${bucketName}/${r2Prefix}`;
      const startTime = Date.now();

      const syncCommand = [
        'rclone',
        'sync',
        sitePath,
        `r2-temp:${r2Path}`,
        '--config',
        configPath,
        '--transfers',
        '32',
        '--checkers',
        '32',
        '--s3-chunk-size',
        '64M',
        '--progress',
        '--stats',
        '5s',
        '--use-server-modtime',
        '--fast-list',
        '--delete-after',
        '--s3-disable-checksum',
      ].join(' ');

      execSync(syncCommand, {
        stdio: 'inherit',
        env: { ...process.env },
      });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[R2 Deploy] ✅ Sync completed in ${duration}s using rclone`);

      return {
        success: true,
        r2Path: r2Prefix,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error('[R2 Deploy] ❌ rclone deployment failed:', errorMessage);

      if (
        errorMessage.includes('command not found') ||
        errorMessage.includes('rclone: not found')
      ) {
        console.error('[R2 Deploy] 💡 Install rclone for faster uploads');
      }

      return {
        success: false,
        error: errorMessage,
      };
    } finally {
      try {
        if (fs.existsSync(configPath)) {
          fs.unlinkSync(configPath);
        }
      } catch (cleanupError) {}
    }
  }

  async deployWithCustom(options) {
    let unhandledErrorHandler;
    try {
      const { siteId, sitePath, environment, deployId } = options;
      const r2Prefix = `sites/${siteId}/${deployId}`;

      const files = await getAllFiles(sitePath, sitePath);
      console.log(
        `[R2 Deploy] Uploading ${files.length} files to ${r2Prefix}/...`
      );

      let currentConcurrency = 30;
      const client = getS3Client();
      const failedFiles = [];

      unhandledErrorHandler = (err) => {
        if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return;
        throw err;
      };
      process.on('uncaughtException', unhandledErrorHandler);

      const processFile = async (file, index) => {
        const filePath = path.join(sitePath, file);
        const r2Key = `${r2Prefix}/${file.replace(/\\/g, '/')}`;
        const contentType = getContentType(filePath);

        try {
          const { stat, readFile } = await import('fs/promises');
          const stats = await stat(filePath);
          const body = await readFile(filePath);

          const command = new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: r2Key,
            Body: body,
            ContentType: contentType,
          });

          const MAX_RETRIES = 3;
          let attempt = 0;
          while (attempt <= MAX_RETRIES) {
            try {
              await client.send(command);
              return r2Key;
            } catch (error) {
              attempt++;
              if (attempt > MAX_RETRIES) {
                failedFiles.push({ file, error: error.message });
                return null;
              }
              await new Promise((resolve) =>
                setTimeout(resolve, 1000 * attempt)
              );
            }
          }
        } catch (error) {
          failedFiles.push({ file, error: error.message });
          return null;
        }
      };

      await processWithConcurrency(files, currentConcurrency, processFile);

      if (failedFiles.length > 0) {
        console.error(
          `[R2 Deploy] ❌ Failed to upload ${failedFiles.length} files`
        );
        return { success: false, error: 'Files failed to upload' };
      }

      process.removeListener('uncaughtException', unhandledErrorHandler);
      return { success: true, r2Path: r2Prefix };
    } catch (error) {
      if (typeof unhandledErrorHandler !== 'undefined') {
        process.removeListener('uncaughtException', unhandledErrorHandler);
      }
      return { success: false, error: error.message };
    }
  }

  async deploy(options) {
    if (this.isRcloneAvailable()) {
      const rcloneResult = await this.deployWithRclone(options);
      if (rcloneResult.success) return rcloneResult;
    }
    return await this.deployWithCustom(options);
  }
}

// ============================================================================
// Point 4: KV Router (Cloudflare KV API - text/plain for PUT)
// ============================================================================

const CLOUDFLARE_KV_NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_R2_ACCOUNT_ID;

function getKVApiUrl() {
  if (!CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('CLOUDFLARE_R2_ACCOUNT_ID is required for KV API access');
  }
  return `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}`;
}

async function makeKVRequest(method, path, body) {
  if (!CLOUDFLARE_API_TOKEN) {
    throw new Error('CLOUDFLARE_API_TOKEN is required for KV API access');
  }
  if (!CLOUDFLARE_KV_NAMESPACE_ID) {
    throw new Error('CLOUDFLARE_KV_NAMESPACE_ID is required for KV API access');
  }

  const url = `${getKVApiUrl()}${path}`;
  const headers = {
    Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
  };

  if (method === 'PUT' && body !== undefined) {
    headers['Content-Type'] = 'text/plain';
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const options = { method, headers };
  if (body !== undefined) {
    options.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Cloudflare KV API error: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  if (method === 'GET') {
    return response.text();
  }
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

async function getRoute(hostname) {
  try {
    const value = await makeKVRequest(
      'GET',
      `/values/${encodeURIComponent(hostname)}`
    );
    if (!value) return null;
    return JSON.parse(value);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.includes('404') || msg.includes('not found')) return null;
    console.warn(`[KV Router] ⚠️  Could not get route for ${hostname}:`, msg);
    return null;
  }
}

async function setRoute(hostname, route) {
  const value = JSON.stringify({
    ...route,
    updatedAt: new Date().toISOString(),
  });
  await makeKVRequest('PUT', `/values/${encodeURIComponent(hostname)}`, value);
  console.log(`[KV Router] ✅ Set route: ${hostname} → ${route.prefix}`);
}

// ============================================================================
// Point 5: Worker Routes & DNS
// ============================================================================

function getWorkersApiUrl() {
  if (!CLOUDFLARE_ACCOUNT_ID) {
    throw new Error(
      'CLOUDFLARE_R2_ACCOUNT_ID is required for Workers API access'
    );
  }
  return `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/services/${WORKER_NAME}`;
}

const zoneIdCache = new Map();

/**
 * Resolve Cloudflare zone id for a hostname. Tries zone names from longest suffix
 * to shortest (min 2 labels), so multi-part TLDs work (e.g. hout-bay-guest-house.co.za
 * instead of wrongly using co.za from slice(-2)).
 */
async function getZoneId(hostname) {
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID) return null;
  let host = String(hostname).replace(/\.$/, '').toLowerCase();
  if (host.startsWith('www.')) {
    host = host.slice(4);
  }
  const cacheKey = host;
  if (zoneIdCache.has(cacheKey)) {
    return zoneIdCache.get(cacheKey);
  }

  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) {
    const resolved = Promise.resolve(null);
    zoneIdCache.set(cacheKey, resolved);
    return resolved;
  }

  const promise = (async () => {
    try {
      for (let depth = labels.length; depth >= 2; depth--) {
        const candidate = labels.slice(-depth).join('.');
        const url = `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(candidate)}`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
        });
        if (!response.ok) continue;
        const data = await response.json();
        if (data.success && data.result?.length > 0) {
          return data.result[0].id;
        }
      }
      return null;
    } catch {
      return null;
    }
  })();

  zoneIdCache.set(cacheKey, promise);
  return promise;
}

async function getDnsRecords(zoneId, name) {
  try {
    if (!CLOUDFLARE_API_TOKEN) return [];
    let url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;
    if (name) url += `?name=${encodeURIComponent(name)}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.success && data.result ? data.result : [];
  } catch {
    return [];
  }
}

function getWorkerDnsTarget() {
  if (process.env.CLOUDFLARE_WORKER_DNS_TARGET) {
    return process.env.CLOUDFLARE_WORKER_DNS_TARGET;
  }

  if (HERO_SITES_DOMAIN === 'hero-pages.com') {
    return `${WORKER_NAME}.hero-pages.workers.dev`;
  }

  throw new Error(
    'CLOUDFLARE_WORKER_DNS_TARGET is required when HERO_SITES_DOMAIN is not hero-pages.com'
  );
}

function dnsRecordNameMatches(recordName, name) {
  return (
    recordName.replace(/\.$/, '').toLowerCase() ===
    name.replace(/\.$/, '').toLowerCase()
  );
}

async function deleteDnsRecord(zoneId, record) {
  try {
    if (!CLOUDFLARE_API_TOKEN) {
      throw new Error('CLOUDFLARE_API_TOKEN is required for DNS API access');
    }
    const deleteUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${record.id}`;
    const response = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    if (response.ok) {
      const data = await response.json();
      if (data.success) {
        console.log(`[DNS] ✅ Deleted ${record.type} record: ${record.name}`);
        return true;
      }
    }
    return false;
  } catch (err) {
    console.warn(
      `[DNS] ⚠️  Could not delete DNS record ${record.name}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

async function removeConflictingAddressRecords(zoneId, name) {
  const records = await getDnsRecords(zoneId, name);
  const conflictingRecords = records.filter(
    (record) =>
      dnsRecordNameMatches(record.name, name) &&
      (record.type === 'A' || record.type === 'AAAA')
  );

  if (conflictingRecords.length === 0) return true;

  const results = await Promise.all(
    conflictingRecords.map((record) => deleteDnsRecord(zoneId, record))
  );
  return results.every(Boolean);
}

async function createDnsRecord(zoneId, name, target, proxied = true) {
  try {
    if (!CLOUDFLARE_API_TOKEN) {
      throw new Error('CLOUDFLARE_API_TOKEN is required for DNS API access');
    }
    const existing = await getDnsRecords(zoneId, name);
    const existingRecord = existing.find(
      (r) => dnsRecordNameMatches(r.name, name) && r.type === 'CNAME'
    );
    const recordData = {
      type: 'CNAME',
      name,
      content: target,
      ttl: 1,
      proxied,
    };
    if (existingRecord) {
      const contentMatches =
        String(existingRecord.content).replace(/\.$/, '').toLowerCase() ===
        String(target).replace(/\.$/, '').toLowerCase();
      const proxiedMatches =
        Boolean(existingRecord.proxied) === Boolean(proxied);
      if (contentMatches && proxiedMatches) {
        console.log(`[DNS] ✅ CNAME already correct: ${name} → ${target}`);
        return true;
      }
      const updateUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${existingRecord.id}`;
      const response = await fetch(updateUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(recordData),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          console.log(`[DNS] ✅ Updated DNS record: ${name} → ${target}`);
          return true;
        }
      }
    } else {
      const createUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;
      const response = await fetch(createUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(recordData),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          console.log(`[DNS] ✅ Created DNS record: ${name} → ${target}`);
          return true;
        }
      }
    }
    return false;
  } catch (err) {
    console.warn(
      `[DNS] ⚠️  Could not create DNS record ${name}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

let customDomainsListCache = null;
let customDomainsFetchInFlight = null;

async function getCustomDomains(options = {}) {
  const { forceRefresh = false } = options;
  if (!forceRefresh && customDomainsListCache !== null) {
    return customDomainsListCache;
  }
  if (!forceRefresh && customDomainsFetchInFlight) {
    return customDomainsFetchInFlight;
  }

  const fetchPromise = (async () => {
    try {
      const url = `${getWorkersApiUrl()}/domains`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        return [];
      }
      const data = await response.json();
      let list = [];
      if (data?.success && Array.isArray(data.result)) {
        list = data.result.map((d) => d.hostname || d);
      } else if (data?.result?.items) {
        list = data.result.items.map((d) => d.hostname || d);
      } else if (data?.result?.hostname) {
        list = [data.result.hostname];
      }
      customDomainsListCache = list;
      return list;
    } catch {
      return [];
    } finally {
      customDomainsFetchInFlight = null;
    }
  })();

  customDomainsFetchInFlight = fetchPromise;
  return fetchPromise;
}

function appendCustomDomainsCache(hostname) {
  if (customDomainsListCache === null) return;
  const normalized = hostname.replace(/\.$/, '');
  const exists = customDomainsListCache.some(
    (d) => d.replace(/\.$/, '') === normalized
  );
  if (!exists) {
    customDomainsListCache.push(normalized);
  }
}

async function addCustomDomain(hostname) {
  try {
    const existing = await getCustomDomains();
    // Normalize hostname for comparison (some APIs return with/without trailing dot)
    const normalizedHostname = hostname.replace(/\.$/, '');
    const exists = existing.some(
      (d) => d.replace(/\.$/, '') === normalizedHostname
    );

    if (exists) {
      console.log(`[Worker Routes] ✅ Domain ${hostname} already configured.`);
      return true;
    }

    // Attempt to add as Worker Custom Domain first
    const url = `${getWorkersApiUrl()}/domains`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hostname: normalizedHostname }),
    });

    const data = await response.json();
    if (response.ok && data?.success) {
      console.log(`[Worker Routes] ✅ Added custom domain: ${hostname}`);
      appendCustomDomainsCache(normalizedHostname);
      return true;
    }

    // If it fails because it already exists as a route or for other common reasons, check routes
    const zoneId = await getZoneId(hostname);
    if (zoneId) {
      const routesUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/workers/routes`;
      const routeResponse = await fetch(routesUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pattern: `${hostname}/*`, script: WORKER_NAME }),
      });
      const routeData = await routeResponse.json();
      if (routeResponse.ok && routeData?.success) {
        console.log(`[Worker Routes] ✅ Added worker route for ${hostname}`);
        appendCustomDomainsCache(normalizedHostname);
        return true;
      }

      // Check if it failed because it already exists
      const isAlreadyExists = routeData?.errors?.some(
        (e) => e.code === 10020 || e.message.includes('already exists')
      );
      if (isAlreadyExists) {
        console.log(`[Worker Routes] ✅ Route for ${hostname} already exists.`);
        return true;
      }
    }

    // If we're here, it failed. Log why.
    const errorMsg = data?.errors?.[0]?.message || 'Unknown error';
    console.warn(
      `[Worker Routes] ⚠️  Could not add domain ${hostname}: ${errorMsg}`
    );
    return false;
  } catch (err) {
    console.warn(
      `[Worker Routes] ⚠️  Failed to add ${hostname}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

const configuredCloudflareZoneSettings = new Map();

async function ensureSSLConfiguration(zoneId) {
  try {
    const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/ssl`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) return false;
    const data = await response.json();
    if (data?.success && data?.result) {
      const mode = data.result.value;
      if (mode === 'full' || mode === 'full_strict') {
        console.log(`[Worker Routes] ✅ SSL mode: ${mode}`);
        return true;
      }
      console.log(`[Worker Routes] 💡 Set SSL/TLS to Full for ${zoneId}`);
    }
    return false;
  } catch {
    return false;
  }
}

async function ensureAlwaysUseHttps(zoneId) {
  try {
    const getUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/always_use_https`;
    const getResponse = await fetch(getUrl, {
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    const getData = await getResponse.json().catch(() => null);
    if (getResponse.ok && getData?.success && getData?.result?.value === 'on') {
      console.log(
        `[Worker Routes] ✅ Always Use HTTPS already on for ${zoneId}`
      );
      return true;
    }

    const url = getUrl;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: 'on' }),
    });
    const data = await response.json().catch(() => null);

    if (response.ok && data?.success) {
      console.log(`[Worker Routes] ✅ Always Use HTTPS enabled for ${zoneId}`);
      return true;
    }

    const errorMessage =
      data?.errors?.map((error) => error.message).join('; ') ||
      `${response.status} ${response.statusText}`;
    console.warn(
      `[Worker Routes] ⚠️  Could not enable Always Use HTTPS: ${errorMessage}`
    );
    return false;
  } catch (err) {
    console.warn(
      '[Worker Routes] ⚠️  Could not enable Always Use HTTPS:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

async function ensureCloudflareZoneSettings(zoneId) {
  if (configuredCloudflareZoneSettings.has(zoneId)) {
    return configuredCloudflareZoneSettings.get(zoneId);
  }

  const settingsPromise = (async () => {
    const [sslConfigured, alwaysUseHttpsConfigured] = await Promise.all([
      ensureSSLConfiguration(zoneId),
      ensureAlwaysUseHttps(zoneId),
    ]);
    return sslConfigured && alwaysUseHttpsConfigured;
  })();

  configuredCloudflareZoneSettings.set(zoneId, settingsPromise);
  return settingsPromise;
}

async function ensureHeroPagesWildcardRoute() {
  try {
    const zoneId = await getZoneId('hero-pages.com');
    if (!zoneId) {
      console.log(
        '[Worker Routes] ⚠️  hero-pages.com zone not found in Cloudflare.'
      );
      return false;
    }
    await ensureCloudflareZoneSettings(zoneId);
    const routesUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/workers/routes`;
    const checkResponse = await fetch(routesUrl, {
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    if (checkResponse.ok) {
      const data = await checkResponse.json();
      if (data?.success && data?.result) {
        const exists = data.result.some(
          (r) =>
            (r.pattern === '*.hero-pages.com/*' ||
              r.pattern === '*hero-pages.com/*') &&
            r.script === WORKER_NAME
        );
        if (exists) {
          console.log(
            '[Worker Routes] ✅ Wildcard route *.hero-pages.com/* exists'
          );
          return true;
        }
      }
    }
    const addResponse = await fetch(routesUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pattern: '*.hero-pages.com/*',
        script: WORKER_NAME,
      }),
    });
    if (addResponse.ok) {
      const data = await addResponse.json();
      if (data?.success) {
        console.log(
          '[Worker Routes] ✅ Added wildcard route *.hero-pages.com/*'
        );
        return true;
      }
    }
    return false;
  } catch (err) {
    console.warn(
      '[Worker Routes] ⚠️  Could not ensure wildcard route:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

async function createSubdomainDnsRecords(subdomain, target) {
  try {
    const zoneId = await getZoneId('hero-pages.com');
    if (!zoneId) {
      console.warn('[DNS] ⚠️  hero-pages.com zone not found');
      return false;
    }
    if (!target) {
      target = getWorkerDnsTarget();
    }
    const subdomainName = `${subdomain}.${HERO_SITES_DOMAIN}`;
    const wwwSubdomainName = `www.${subdomain}.${HERO_SITES_DOMAIN}`;

    await ensureCloudflareZoneSettings(zoneId);

    // Register both naked and www subdomains for the test site
    await Promise.all([
      addCustomDomain(subdomainName),
      addCustomDomain(wwwSubdomainName),
    ]);

    const [ok1, ok2] = await Promise.all([
      createDnsRecord(zoneId, subdomainName, target, true),
      createDnsRecord(zoneId, wwwSubdomainName, target, true),
    ]);

    if (ok1 && ok2) {
      console.log(
        `[DNS] ✅ DNS records for ${subdomainName} and ${wwwSubdomainName}`
      );
    }
    return ok1 && ok2;
  } catch (err) {
    console.warn(
      `[DNS] ⚠️  Could not create DNS for ${subdomain}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

async function createProductionDnsRecords(mainDomain, target) {
  try {
    const nakedDomain = mainDomain.startsWith('www.')
      ? mainDomain.slice(4)
      : mainDomain;
    const wwwDomain = mainDomain.startsWith('www.')
      ? mainDomain
      : `www.${mainDomain}`;
    const zoneId = await getZoneId(nakedDomain);

    if (!zoneId) {
      console.warn(`[DNS] ⚠️  ${nakedDomain} zone not found`);
      return false;
    }

    const dnsTarget = target || getWorkerDnsTarget();
    await ensureCloudflareZoneSettings(zoneId);

    const [nakedClean, wwwClean] = await Promise.all([
      removeConflictingAddressRecords(zoneId, nakedDomain),
      removeConflictingAddressRecords(zoneId, wwwDomain),
    ]);
    if (!nakedClean || !wwwClean) {
      console.warn(
        `[DNS] ⚠️  Could not remove all conflicting A/AAAA records for ${nakedDomain}`
      );
      return false;
    }

    const [nakedOk, wwwOk] = await Promise.all([
      createDnsRecord(zoneId, nakedDomain, dnsTarget, true),
      createDnsRecord(zoneId, wwwDomain, dnsTarget, true),
    ]);

    if (nakedOk && wwwOk) {
      console.log(
        `[DNS] ✅ Production DNS records for ${nakedDomain} and ${wwwDomain}`
      );
    }
    return nakedOk && wwwOk;
  } catch (err) {
    console.warn(
      `[DNS] ⚠️  Could not create production DNS for ${mainDomain}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

function isPreviewDomainOnHeroPages(hostname) {
  return /^[^.]+\.hero-pages\.com$/.test(hostname);
}

async function ensureCustomDomain(hostname) {
  try {
    if (hostname.includes('.workers.dev')) return;
    if (isPreviewDomainOnHeroPages(hostname)) {
      return await ensureHeroPagesWildcardRoute();
    }
    return await addCustomDomain(hostname);
  } catch (err) {
    console.warn(
      `[Worker Routes] ⚠️  Could not ensure custom domain ${hostname}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

// Point 6: Zone redirects are now handled by the Worker (naked -> www)

// ============================================================================
// Point 8: Validation & helpers
// ============================================================================

function validateCloudflareConfig() {
  const errors = [];
  // Per-site SITE_ID / main domain come from websites.json + switchToClient, not global env.
  const required = [
    'CLOUDFLARE_R2_ACCOUNT_ID',
    'CLOUDFLARE_R2_ACCESS_KEY_ID',
    'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
    'CLOUDFLARE_R2_ENDPOINT',
    'CLOUDFLARE_KV_NAMESPACE_ID',
    'CLOUDFLARE_API_TOKEN',
  ];
  for (const key of required) {
    if (!process.env[key]) errors.push(`${key} is not set`);
  }
  return { isValid: errors.length === 0, errors };
}

function prefixLooksLikeSiteId(prefix, siteId) {
  if (!prefix) return false;
  return (
    prefix.includes(`/sites/${siteId}/`) ||
    prefix.startsWith(`sites/${siteId}/`) ||
    prefix.includes(`sites/${siteId}/`)
  );
}

async function confirmDeploymentTargets({
  siteId,
  deploymentType,
  mainDomain,
  autoConfirm = false,
}) {
  const previewHostname = `${siteId}.${HERO_SITES_DOMAIN}`;

  console.log('\n[Safety] About to deploy with:');
  console.log(`  - SITE_ID: ${siteId}`);
  console.log(`  - Preview URL: https://${previewHostname}`);
  if (deploymentType === 'final') {
    console.log(`  - Live domain: https://${mainDomain}`);
  }

  let mainDomainExisting = null;
  if (deploymentType === 'final' && mainDomain) {
    mainDomainExisting = await getRoute(mainDomain);
    if (mainDomainExisting) {
      const existingSiteId = mainDomainExisting.siteId;
      const existingPrefix = mainDomainExisting.prefix;

      const siteIdMismatch =
        typeof existingSiteId === 'string' && existingSiteId !== siteId;
      const prefixMismatch =
        typeof existingPrefix === 'string' &&
        !prefixLooksLikeSiteId(existingPrefix, siteId);

      if (siteIdMismatch || prefixMismatch) {
        if (autoConfirm) {
          console.error(
            '\n[Safety] Main domain KV route points to a different site/prefix; cannot auto-confirm. Remove --yes and resolve manually.'
          );
          process.exit(1);
        }
        console.log(
          '\n[Safety] ⚠️  MAIN DOMAIN already has a different route:'
        );
        console.log(
          `  - ${mainDomain} → ${existingPrefix ?? '(no prefix)'} (siteId: ${existingSiteId ?? 'unknown'})`
        );
        console.log(`  - You are trying to deploy with SITE_ID: ${siteId}`);

        const { typedSiteId } = await inquirer.prompt([
          {
            type: 'input',
            name: 'typedSiteId',
            message: `Type the SITE_ID ("${siteId}") to confirm and continue:`,
            validate: (input) => {
              if (input.trim() === siteId) return true;
              return 'SITE_ID did not match. Aborting for safety.';
            },
          },
        ]);
        if (typedSiteId.trim() !== siteId) process.exit(1);
        return;
      }
    }
  }

  if (autoConfirm) {
    console.log('[Safety] Auto-confirmed (--yes / -y).');
    return;
  }

  if (deploymentType === 'final' && mainDomain && mainDomainExisting) {
    const idOk =
      typeof mainDomainExisting.siteId === 'string' &&
      mainDomainExisting.siteId === siteId;
    const prefix = mainDomainExisting.prefix;
    const prefixOk =
      typeof prefix !== 'string' ||
      prefix === '' ||
      prefixLooksLikeSiteId(prefix, siteId);
    if (idOk && prefixOk) {
      console.log(
        '[Safety] Main domain KV route already matches this SITE_ID; skipping confirmation prompt.'
      );
      return;
    }
  }

  if (deploymentType === 'test') {
    const previewExisting = await getRoute(previewHostname);
    if (
      previewExisting &&
      typeof previewExisting.siteId === 'string' &&
      previewExisting.siteId === siteId
    ) {
      console.log(
        '[Safety] Preview KV route already matches this SITE_ID; skipping confirmation prompt.'
      );
      return;
    }
  }

  // const { ok } = await inquirer.prompt([
  //   {
  //     type: 'confirm',
  //     name: 'ok',
  //     message: 'Proceed with this SITE_ID / domain configuration?',
  //     default: false,
  //   },
  // ]);

  // if (!ok) {
  //   console.log('[Safety] Aborted.');
  //   process.exit(1);
  // }
}

function getStaticBuildPath(productId, preferredDeployId = null) {
  if (preferredDeployId) {
    const preferredPath = path.join(
      projectRoot,
      'static-builds',
      productId,
      preferredDeployId
    );
    if (fs.existsSync(preferredPath)) return preferredPath;
  }
  const siteDir = path.join(projectRoot, 'static-builds', productId);
  if (fs.existsSync(siteDir)) {
    const deployDirs = fs
      .readdirSync(siteDir)
      .filter((item) => fs.statSync(path.join(siteDir, item)).isDirectory())
      .sort()
      .reverse();
    if (deployDirs.length > 0) return path.join(siteDir, deployDirs[0]);
  }
  const fallbacks = [
    path.join(projectRoot, 'dist'),
    path.join(projectRoot, 'tmp', 'sites', productId),
    path.join(projectRoot, 'out', productId),
  ];
  for (const p of fallbacks) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function getR2Path(siteId, environment) {
  try {
    const hostname = `${siteId}.${HERO_SITES_DOMAIN}`;
    const route = await getRoute(hostname);
    return route?.prefix ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// Point 7: Post-deployment setup
// ============================================================================

async function ensureWorkerRoute() {
  console.log(`\n🔗 Ensuring Worker route for *.${HERO_SITES_DOMAIN}...`);
  try {
    return await ensureHeroPagesWildcardRoute();
  } catch (err) {
    console.warn(
      '⚠️  Could not ensure Worker route:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

async function setupKVRoute(
  hostname,
  siteId,
  r2Path,
  environment,
  silentIfCorrect = false,
  defaultLang = undefined
) {
  try {
    const existing = await getRoute(hostname);
    if (existing && existing.prefix === r2Path) {
      if (!silentIfCorrect) {
        console.log(
          `[KV Router] ✅ Route already correct: ${hostname} → ${r2Path}`
        );
      }
      return true;
    }

    console.log(`\n🔗 Updating KV route: ${hostname} → ${r2Path}...`);
    await setRoute(hostname, {
      siteId,
      environment,
      prefix: r2Path,
      domain: hostname,
      updatedAt: new Date().toISOString(),
      ...(defaultLang !== undefined && { defaultLang }),
    });
    console.log(`✅ KV route updated: ${hostname} → ${r2Path}`);
    return true;
  } catch (err) {
    console.error(
      '❌ Failed to update KV route:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

async function setupPostDeployment(
  siteId,
  r2Path,
  environment,
  deploymentType,
  mainDomain,
  runOneTimeSetup = true,
  defaultLang = undefined
) {
  const previewHostname = `${siteId}.${HERO_SITES_DOMAIN}`;
  const results = {
    heroPagesKv: false,
    mainDomainKv: false,
    workerRoute: false,
    trailingSlash: true,
  };

  if (runOneTimeSetup) {
    console.log(`\n🔗 Setting up hero-pages.com route: ${previewHostname}...`);
    try {
      console.log(`📝 Creating DNS records for ${previewHostname}...`);
      await createSubdomainDnsRecords(siteId);
    } catch (err) {
      console.warn(
        '⚠️  Could not create DNS records:',
        err instanceof Error ? err.message : err
      );
    }
  }

  results.heroPagesKv = await setupKVRoute(
    previewHostname,
    siteId,
    r2Path,
    environment,
    !runOneTimeSetup,
    defaultLang
  );

  if (deploymentType === 'final' && mainDomain) {
    results.mainDomainKv = await setupKVRoute(
      mainDomain,
      siteId,
      r2Path,
      environment,
      !runOneTimeSetup,
      defaultLang
    );

    if (runOneTimeSetup) {
      const nakedDomain = mainDomain.startsWith('www.')
        ? mainDomain.slice(4)
        : mainDomain;
      const wwwDomain = mainDomain.startsWith('www.')
        ? mainDomain
        : `www.${mainDomain}`;
      try {
        results.productionDns = await createProductionDnsRecords(mainDomain);
        const [nakedWorkerRoute, wwwWorkerRoute] = await Promise.all([
          ensureCustomDomain(nakedDomain),
          ensureCustomDomain(wwwDomain),
        ]);
        results.workerRoute = nakedWorkerRoute && wwwWorkerRoute;

        if (!results.productionDns) {
          console.warn(
            '[Deploy] ⚠️  Production DNS setup may have failed; check Cloudflare DNS.'
          );
        }
        if (!results.workerRoute) {
          console.warn(
            '[Deploy] ⚠️  Production Worker route setup may have failed; check Worker triggers.'
          );
        }
      } catch (err) {
        console.warn(
          '⚠️  Could not ensure worker route for main domain:',
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  return results;
}

// ============================================================================
// Client discovery & selection (enquirer)
// ============================================================================

async function getEnquirer() {
  try {
    await import('enquirer');
  } catch {
    console.log('[deploy] enquirer not found — installing...');
    const { spawnSync } = await import('child_process');
    const result = spawnSync('pnpm', ['add', '-D', 'enquirer'], {
      stdio: 'inherit',
      cwd: projectRoot,
    });
    if (result.status !== 0) {
      console.error('Failed to install enquirer. Aborting.');
      process.exit(1);
    }
  }
  const { default: enquirer } = await import('enquirer');
  return enquirer;
}

function discoverClients() {
  const dataDir = path.join(projectRoot, 'src', 'data');
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((e) => {
      if (!e.isDirectory() && !e.isSymbolicLink()) return false;
      if (
        e.name === 'current' ||
        e.name === '_template' ||
        e.name.startsWith('.')
      ) {
        return false;
      }
      return fs.existsSync(path.join(dataDir, e.name, 'websites.json'));
    })
    .map((e) => e.name);
}

async function promptClient(enquirer, clients) {
  if (clients.length === 0) {
    console.error('❌ No client folders with websites.json found in src/data/');
    process.exit(1);
  }
  if (clients.length === 1) {
    console.log(`ℹ️  Using client: ${clients[0]}`);
    return clients[0];
  }
  const { client } = await enquirer.prompt({
    type: 'select',
    name: 'client',
    message: 'Which client do you want to deploy?',
    choices: clients,
  });
  return client;
}

function readClientWebsites(clientId) {
  const websitesPath = path.join(
    projectRoot,
    'src',
    'data',
    clientId,
    'websites.json'
  );
  try {
    const data = JSON.parse(fs.readFileSync(websitesPath, 'utf-8'));
    const topLevelDomain = data.clientDomain;
    return (data.websites ?? [])
      .map((w) => ({ ...w, clientDomain: w.clientDomain ?? topLevelDomain }))
      .filter((w) => w.id && (w.deployDomain || w.clientDomain));
  } catch {
    return [];
  }
}

async function promptWebsites(enquirer, websites) {
  if (websites.length === 0) {
    console.error('❌ No websites with a deployDomain found in websites.json');
    process.exit(1);
  }
  if (websites.length === 1) {
    const w = websites[0];
    const domain = w.deployDomain ?? w.clientDomain;
    console.log(`ℹ️  Using website: ${w.id} (${domain})`);
    return [w];
  }
  const ALL_LABEL = '★ All websites';
  const labels = [
    ALL_LABEL,
    ...websites.map((w) => {
      const domain = w.deployDomain ?? w.clientDomain;
      const label = w.business?.name ?? '';
      return `${w.id}  → ${domain}${label ? `  (${label})` : ''}`;
    }),
  ];

  const trimmed = (c) => String(c).trim();
  const siteLabels = labels.slice(1);

  // initial: [] — enquirer's default initial is 0, which enables only row 0 ("★ All websites").
  // That made Enter-without-toggling deploy everything; combined with specific rows it always matched ALL_LABEL.
  while (true) {
    const { websiteChoices: rawChoices } = await enquirer.prompt({
      type: 'multiselect',
      name: 'websiteChoices',
      message:
        'Which websites do you want to deploy? (space to toggle, enter to confirm)',
      choices: labels,
      hint: 'Select "★ All websites" alone to deploy every site, or toggle only the sites you need.',
      initial: [],
    });
    let websiteChoices = Array.isArray(rawChoices) ? [...rawChoices] : [];

    if (websiteChoices.length === 0) {
      console.log(
        'ℹ️  No websites selected — toggle at least one row, then press Enter.'
      );
      continue;
    }

    const hasAll = websiteChoices.some((c) => trimmed(c) === ALL_LABEL);
    const concrete = websiteChoices.filter((c) => trimmed(c) !== ALL_LABEL);

    // If both "★ All websites" and specific rows are checked, only the specifics count
    // (users often add sites but forget to uncheck "All", which used to force a full deploy).
    if (hasAll && concrete.length > 0) {
      websiteChoices = concrete;
    } else if (hasAll && concrete.length === 0) {
      return websites;
    }

    const resolved = websiteChoices
      .map((choice) => {
        const chosenId = String(choice).split('  →')[0].trim();
        return (
          websites.find((w) => w.id === chosenId) ??
          websites[siteLabels.indexOf(choice)]
        );
      })
      .filter(Boolean);

    if (resolved.length === 0) {
      console.log('ℹ️  Could not map selection to websites — try again.');
      continue;
    }
    return resolved;
  }
}

// ============================================================================
// Client switcher — mirrors use-client.ts so the build reads the right data
// ============================================================================

const EMPTY_INTERNAL_LINKS = {
  generatedAt: new Date(0).toISOString(),
  version: 1,
  pageCount: 0,
  linkCount: 0,
  links: {},
};

function switchToClient(clientId, siteId, deployDomain) {
  const dataDir = path.join(projectRoot, 'src', 'data');
  const currentPath = path.join(dataDir, 'current');
  const clientPath = path.join(dataDir, clientId);

  // Remove old current
  if (fs.existsSync(currentPath)) {
    const stat = fs.lstatSync(currentPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fs.unlinkSync(currentPath);
    } else {
      fs.rmSync(currentPath, { recursive: true });
    }
  }

  // Create current/ as a directory with shared config files + selected site subfolder only
  fs.mkdirSync(currentPath, { recursive: true });

  const entries = fs.readdirSync(clientPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const src = path.join(clientPath, entry.name);
      const dest = path.join(currentPath, entry.name);

      // Write a filtered websites.json that only includes the current site so
      // the build doesn't generate pages for every other site in the client.
      if (entry.name === 'websites.json') {
        try {
          const fullData = JSON.parse(fs.readFileSync(src, 'utf-8'));
          const filteredData = {
            ...fullData,
            websites: (fullData.websites ?? []).filter((w) => w.id === siteId),
          };
          fs.writeFileSync(
            dest,
            JSON.stringify(filteredData, null, 2),
            'utf-8'
          );
          console.log(
            `[setup] src/data/current/websites.json ← filtered to site: ${siteId}`
          );
        } catch {
          fs.copyFileSync(src, dest);
        }
        continue;
      }

      try {
        fs.symlinkSync(src, dest);
      } catch {
        fs.copyFileSync(src, dest);
      }
    }
  }

  // Symlink individual site data files directly into current/ (flat, not as subfolder)
  const siteDataPath = path.join(clientPath, siteId);
  if (fs.existsSync(siteDataPath) && fs.statSync(siteDataPath).isDirectory()) {
    for (const file of fs.readdirSync(siteDataPath)) {
      const src = path.join(siteDataPath, file);
      if (!fs.statSync(src).isFile()) continue;
      const dest = path.join(currentPath, file);
      if (fs.existsSync(dest)) continue;
      try {
        fs.symlinkSync(src, dest);
      } catch {
        fs.copyFileSync(src, dest);
      }
    }
  }

  // internalLinks.json is optional but must exist for Vite module resolution
  const internalLinksPath = path.join(currentPath, 'internalLinks.json');
  if (!fs.existsSync(internalLinksPath)) {
    fs.writeFileSync(
      internalLinksPath,
      JSON.stringify(EMPTY_INTERNAL_LINKS, null, 2),
      'utf-8'
    );
  }

  console.log(
    `[setup] src/data/current ← shared files + ${siteId} site files from src/data/${clientId}`
  );

  // Write CLIENT_ID + SITE_ID + DEPLOY_DOMAIN to .env.local so other tools stay in sync
  const envLocalPath = path.join(projectRoot, '.env.local');
  let content = '';
  if (fs.existsSync(envLocalPath)) {
    const lines = fs.readFileSync(envLocalPath, 'utf-8').split('\n');
    const filtered = lines.filter(
      (l) =>
        !l.startsWith('CLIENT_ID=') &&
        !l.startsWith('SITE_ID=') &&
        !l.startsWith('DEPLOY_DOMAIN=') &&
        !l.startsWith('SITE_MAIN_DOMAIN=')
    );
    content = filtered.join('\n').replace(/\n+$/, '');
    if (content) content += '\n';
  }
  content += `CLIENT_ID=${clientId}\n`;
  content += `SITE_ID=${siteId}\n`;
  if (deployDomain) {
    content += `DEPLOY_DOMAIN=${deployDomain}\n`;
    content += `SITE_MAIN_DOMAIN=${deployDomain}\n`;
  }
  fs.writeFileSync(envLocalPath, content, 'utf-8');
  process.env.CLIENT_ID = clientId;
  process.env.SITE_ID = siteId;
  if (deployDomain) {
    process.env.DEPLOY_DOMAIN = deployDomain;
    process.env.SITE_MAIN_DOMAIN = deployDomain;
  } else {
    delete process.env.DEPLOY_DOMAIN;
    delete process.env.SITE_MAIN_DOMAIN;
  }
  console.log(
    `[setup] .env.local → CLIENT_ID=${clientId}, SITE_ID=${siteId}${deployDomain ? `, DEPLOY_DOMAIN=${deployDomain}, SITE_MAIN_DOMAIN=${deployDomain}` : ''}`
  );

  copyLlmTxtToPublic(projectRoot, clientId, siteId);
  copyClientFaviconToPublic(projectRoot, clientId, { required: true });

  // Same as pnpm dev: bake active client's theme.config.json → globals.css before build
  console.log('[setup] Syncing theme → src/styles/globals.css...');
  execFileSync(
    process.execPath,
    [path.join(projectRoot, 'scripts', 'dev', 'sync-theme-to-globals.mjs')],
    { stdio: 'inherit', cwd: projectRoot, env: process.env }
  );
}

// ============================================================================
// Ratgeber page exclusion — move to backup before build, restore after
// ============================================================================

const RATGEBER_SOURCES = [
  path.join(projectRoot, 'src', 'pages', '[lang]', 'ratgeber.astro'),
  path.join(projectRoot, 'src', 'pages', '[lang]', 'ratgeber'),
];
const RATGEBER_BACKUP_DIR = path.join(projectRoot, '_ratgeber-backup');

function backupRatgeberPages() {
  if (fs.existsSync(RATGEBER_BACKUP_DIR)) {
    fs.rmSync(RATGEBER_BACKUP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(RATGEBER_BACKUP_DIR, { recursive: true });

  for (const src of RATGEBER_SOURCES) {
    if (fs.existsSync(src)) {
      const name = path.basename(src);
      const dest = path.join(RATGEBER_BACKUP_DIR, name);
      fs.renameSync(src, dest);
      console.log(
        `[Build] 📦 Excluded: ${path.relative(projectRoot, src)} → _ratgeber-backup/${name}`
      );
    }
  }
}

function restoreRatgeberPages() {
  if (!fs.existsSync(RATGEBER_BACKUP_DIR)) return;

  for (const dest of RATGEBER_SOURCES) {
    const name = path.basename(dest);
    const src = path.join(RATGEBER_BACKUP_DIR, name);
    if (fs.existsSync(src)) {
      fs.renameSync(src, dest);
      console.log(
        `[Build] 📦 Restored: _ratgeber-backup/${name} → ${path.relative(projectRoot, dest)}`
      );
    }
  }

  fs.rmSync(RATGEBER_BACKUP_DIR, { recursive: true, force: true });
}

// ============================================================================
// Public images — align with 03-organize-drive-assets (public/images/<siteId>/)
// ============================================================================

const SITE_IMAGE_EXTENSIONS = new Set([
  '.webp',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.svg',
  '.avif',
  '.ico',
]);

/** True if dir exists and contains at least one image file (recursive). */
function directoryHasSiteImages(dirPath) {
  if (!fs.existsSync(dirPath)) return false;
  if (!fs.statSync(dirPath).isDirectory()) return false;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (directoryHasSiteImages(full)) return true;
    } else if (
      SITE_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Before build: if this site has no files under public/images/<siteId>, pull from
 * Google Drive and run organize (same as pnpm 02-pull-assets + 03-organize-assets).
 */
function ensurePublicImagesForSite(clientId, siteId) {
  const siteImagesDir = path.join(projectRoot, 'public', 'images', siteId);
  if (directoryHasSiteImages(siteImagesDir)) {
    console.log(
      `[Build] ✓ Images present under ${path.relative(projectRoot, siteImagesDir)}`
    );
    return;
  }
  console.log(
    `[Build] 📥 No images under public/images/${siteId} — running Drive pull and organize...`
  );
  const execOpts = { stdio: 'inherit', cwd: projectRoot, env: process.env };
  execFileSync(
    process.execPath,
    [
      '--no-warnings=punycode',
      path.join(projectRoot, 'scripts', '02-pull-from-google-drive.mjs'),
      `--client=${clientId}`,
    ],
    execOpts
  );
  execFileSync(
    process.execPath,
    [
      path.join(projectRoot, 'scripts', '03-organize-drive-assets.mjs'),
      `--client=${clientId}`,
    ],
    execOpts
  );
}

/**
 * @param {{ siteId: string; clientId: string; mainDomain: string }} clientConfig
 * @param {'test'|'final'} deploymentType
 * @param {{ skipBuild?: boolean; runOneTimeSetup?: boolean; skipSafetyConfirm?: boolean }} options
 */
async function deploySite(clientConfig, deploymentType, options = {}) {
  const { siteId, clientId, mainDomain } = clientConfig;
  const {
    skipBuild = false,
    runOneTimeSetup = true,
    skipSafetyConfirm = false,
    autoConfirm = false,
  } = options;

  // Point 8: Validate Cloudflare config before any work
  const configValidation = validateCloudflareConfig();
  if (!configValidation.isValid) {
    console.error('\n❌ Cloudflare configuration is incomplete:');
    configValidation.errors.forEach((e) => console.error(`   ❌ ${e}`));
    console.error(
      '\n💡 Set: CLOUDFLARE_R2_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY, CLOUDFLARE_R2_ENDPOINT, CLOUDFLARE_KV_NAMESPACE_ID, CLOUDFLARE_API_TOKEN'
    );
    process.exit(1);
  }

  if (!skipSafetyConfirm) {
    await confirmDeploymentTargets({
      siteId,
      deploymentType,
      mainDomain,
      autoConfirm,
    });
  }

  if (!skipBuild) {
    ensurePublicImagesForSite(clientId, siteId);
    // Build Astro with production site URL (sitemap, canonicals)
    console.log(`[Build] 🏗️  Building Astro project for ${siteId}...`);
    backupRatgeberPages();
    try {
      execSync('pnpm build', {
        stdio: 'inherit',
        cwd: projectRoot,
        env: {
          ...process.env,
          SITE_ID: siteId,
          SITE_URL: `https://www.${mainDomain}`,
        },
      });
    } catch (error) {
      console.error('[Build] ❌ Build failed');
      restoreRatgeberPages();
      process.exit(1);
    }
    restoreRatgeberPages();
  } else {
    console.log(`[Build] ⏭️  Skipping build (using existing dist)`);
  }

  const langConfigPath = path.join(
    projectRoot,
    'src/data',
    clientId ?? siteId,
    'language.config.json'
  );
  const langConfig = JSON.parse(fs.readFileSync(langConfigPath, 'utf-8'));
  const defaultLang = langConfig.defaultLanguage ?? 'de';

  const deployId = deploymentType === 'test' ? 'dev' : 'main';
  const environment = deploymentType === 'test' ? 'preview' : 'production';

  // Resolve site path (Point 8: getStaticBuildPath – Astro uses dist/)
  const sitePath =
    getStaticBuildPath(siteId, deployId) || path.join(projectRoot, 'dist');
  if (!fs.existsSync(sitePath)) {
    console.error(`[Deploy] ❌ Site path does not exist: ${sitePath}`);
    process.exit(1);
  }

  console.log(`[Deploy] 📤 Deploying ${deploymentType} → ${deployId}...`);
  const deployer = new R2Deployer();
  const zoneWarmup = Promise.all([
    getZoneId(HERO_SITES_DOMAIN),
    deploymentType === 'final' && process.env.SITE_MAIN_DOMAIN
      ? getZoneId(process.env.SITE_MAIN_DOMAIN)
      : Promise.resolve(null),
  ]);

  const r2Result = await deployer.deploy({
    siteId,
    sitePath,
    environment,
    deployId,
  });

  await zoneWarmup;

  if (!r2Result.success) {
    console.error(`[Deploy] ❌ Failed to deploy to R2`);
    process.exit(1);
  }

  const r2Path = r2Result.r2Path;
  const previewHostname = `${siteId}.${HERO_SITES_DOMAIN}`;

  if (runOneTimeSetup) {
    await ensureWorkerRoute();
  } else {
    console.log(
      '\n⏭️  Skipping one-time setup (Worker route, DNS, custom domain, www redirect).'
    );
  }

  const setupResults = await setupPostDeployment(
    siteId,
    r2Path,
    environment,
    deploymentType,
    deploymentType === 'final' ? mainDomain : null,
    runOneTimeSetup,
    defaultLang
  );

  if (!setupResults.heroPagesKv) {
    console.warn('[Deploy] ⚠️  Preview KV route may have failed; check logs.');
  }

  console.log(`[Deploy] ✅ ${deploymentType} deployment done!`);
  console.log(`[Deploy] 🔗 Preview: https://${previewHostname}`);
  if (deploymentType === 'final') {
    console.log(`[Deploy] 🔗 Live: https://${mainDomain}`);
  }

  const deployedDomains = [`https://${previewHostname}`];
  if (deploymentType === 'final') {
    deployedDomains.push(`https://${mainDomain}`);
  }
  return { deployedDomains };
}

function parseDeployCliFlags(argv) {
  const out = {
    deploymentType: null,
    runOneTimeSetup: null,
    skipBuild: false,
    autoConfirm: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') {
      out.autoConfirm = true;
    } else if (a === '--skip-build') {
      out.skipBuild = true;
    } else if (a === '--setup') {
      out.runOneTimeSetup = true;
    } else if (a === '--no-setup') {
      out.runOneTimeSetup = false;
    } else if (a === '--type' && argv[i + 1]) {
      out.deploymentType = argv[++i].trim();
    } else if (a.startsWith('--type=')) {
      out.deploymentType = a.slice('--type='.length).trim();
    } else if (a.startsWith('-')) {
      console.warn(`[CLI] Unknown flag: ${a}`);
    }
  }
  const valid = ['test', 'final', 'both'];
  if (out.deploymentType && !valid.includes(out.deploymentType)) {
    console.error(
      `[CLI] Invalid --type "${out.deploymentType}". Use: ${valid.join(', ')}`
    );
    process.exit(1);
  }
  return out;
}

// Helper to run deployment
async function run() {
  // ── Step 1: Client selection ──────────────────────────────────────────────
  const enquirer = await getEnquirer();
  const clients = discoverClients();
  const selectedClient = await promptClient(enquirer, clients);

  // ── Step 2: Website selection (multiselect) ──────────────────────────────
  const websites = readClientWebsites(selectedClient);
  const selectedWebsites = await promptWebsites(enquirer, websites);

  console.log(
    `\n✅ Client: ${selectedClient} | Websites selected: ${selectedWebsites.map((w) => w.id).join(', ')}\n`
  );

  // ── Step 3: Deployment type ───────────────────────────────────────────────
  console.log('  Deployment type:');
  console.log('    1) 🧪 Test (preview, hero-pages.com only)');
  console.log('    2) 🚀 Final (production, client domain)');
  console.log('    3) 🔀 Both (build once, deploy test + final)\n');

  const { deploymentType } = await inquirer.prompt([
    {
      type: 'input',
      name: 'deploymentType',
      message: 'Choice (1, 2, or 3):',
      default: '1',
      validate: (input) => {
        const n = input.trim();
        if (n === '1' || n === '2' || n === '3') return true;
        return 'Please enter 1, 2, or 3';
      },
      filter: (input) => {
        const map = { 1: 'test', 2: 'final', 3: 'both' };
        return map[input.trim()] || input;
      },
    },
  ]);

  const runOneTimeSetup = true;
  const allDeployedDomains = new Set();

  // ── Step 4: Deploy each selected website ─────────────────────────────────
  for (const selectedWebsite of selectedWebsites) {
    const mainDomain =
      selectedWebsite.deployDomain ?? selectedWebsite.clientDomain;

    if (!mainDomain) {
      console.error(
        `❌ Could not determine deploy domain for website "${selectedWebsite.id}".\n` +
          `   Add a "deployDomain" field to this entry in src/data/${selectedClient}/websites.json.`
      );
      process.exit(1);
    }

    const clientConfig = {
      siteId: selectedWebsite.id,
      clientId: selectedClient,
      mainDomain,
    };

    if (selectedWebsites.length > 1) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`🚀 Deploying: ${selectedWebsite.id}  → ${mainDomain}`);
      console.log(`${'─'.repeat(60)}`);
    }

    // Switch src/data/current and write .env.local for this website
    switchToClient(selectedClient, selectedWebsite.id, mainDomain);

    if (deploymentType === 'both') {
      await confirmDeploymentTargets({
        siteId: selectedWebsite.id,
        deploymentType: 'both',
        mainDomain,
      });
      const testResult = await deploySite(clientConfig, 'test', {
        skipBuild: false,
        runOneTimeSetup,
        skipSafetyConfirm: true,
      });
      const finalResult = await deploySite(clientConfig, 'final', {
        skipBuild: true,
        runOneTimeSetup,
        skipSafetyConfirm: true,
      });
      for (const domain of testResult.deployedDomains)
        allDeployedDomains.add(domain);
      for (const domain of finalResult.deployedDomains)
        allDeployedDomains.add(domain);
      console.log(
        `\n[Deploy] ✅ Both deployments complete for ${selectedWebsite.id}.`
      );
    } else {
      const result = await deploySite(clientConfig, deploymentType, {
        runOneTimeSetup,
      });
      for (const domain of result.deployedDomains)
        allDeployedDomains.add(domain);
    }
  }

  if (selectedWebsites.length > 1) {
    console.log(`\n✅ All ${selectedWebsites.length} websites deployed.`);
  }

  if (allDeployedDomains.size > 0) {
    const sortedDomains = [...allDeployedDomains].sort((a, b) =>
      a.localeCompare(b)
    );
    console.log('\n🌐 Deployed domains:');
    for (const domain of sortedDomains) {
      console.log(`  - ${domain}`);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
