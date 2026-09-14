import type { Advisory } from '../src/types.js';
export const timestamp = Math.floor(Date.now() / 1000);
export function csaf(id = 'SSA-123456') {
  return {
    document: {
      csaf_version: '2.0',
      title: `${id}: Authentication issue in SIMATIC S7-1500`,
      notes: [
        {
          category: 'summary',
          text: 'A vulnerability affects industrial controllers. Siemens recommends installing the listed update.',
        },
      ],
      tracking: {
        id,
        initial_release_date: new Date((timestamp - 86400) * 1000).toISOString(),
        current_release_date: new Date(timestamp * 1000).toISOString(),
        version: '2',
        revision_history: [
          {
            date: new Date(timestamp * 1000).toISOString(),
            summary: 'Added a fixed firmware version.',
          },
        ],
      },
    },
    product_tree: {
      branches: [
        {
          category: 'product_name',
          name: 'SIMATIC S7-1500 CPU 1516-3 PN/DP',
          branches: [
            {
              category: 'product_version_range',
              name: 'vers:intdot/<3.1',
              product: { product_id: 'affected', name: 'SIMATIC S7-1500 CPU 1516-3 PN/DP < V3.1' },
            },
            {
              category: 'product_version',
              name: 'V3.1',
              product: { product_id: 'fixed', name: 'SIMATIC S7-1500 CPU 1516-3 PN/DP V3.1' },
            },
          ],
        },
        {
          category: 'product_name',
          name: 'WinCC Unified',
          product: { product_id: 'unaffected', name: 'WinCC Unified all versions' },
        },
      ],
      product_groups: [{ group_id: 'g1', product_ids: ['affected'] }],
    },
    vulnerabilities: [
      {
        cve: 'CVE-2026-12345',
        product_status: {
          known_affected: ['affected'],
          fixed: ['fixed'],
          known_not_affected: ['unaffected'],
        },
        remediations: [
          {
            category: 'vendor_fix',
            details: 'Update to V3.1 or later.',
            product_ids: ['affected'],
            url: 'https://support.industry.siemens.com/',
          },
          {
            category: 'mitigation',
            details: 'Limit network access to trusted hosts.',
            group_ids: ['g1'],
          },
        ],
        scores: [
          {
            products: ['affected'],
            cvss_v3: {
              version: '3.1',
              baseScore: 8.8,
              vectorString: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H',
            },
            cvss_v4: { version: '4.0', baseScore: 9.1, vectorString: 'CVSS:4.0/AV:N' },
          },
        ],
      },
    ],
  };
}
export function advisory(overrides: Partial<Advisory> = {}): Advisory {
  return {
    id: 'SSA-123456',
    feedId: 'https://cert-portal.siemens.com/productcert/html/ssa-123456.html',
    title: 'SSA-123456 V1.1: Authentication issue in SIMATIC S7-1500',
    summary: 'A vulnerability affects industrial controllers.',
    link: 'https://cert-portal.siemens.com/productcert/html/ssa-123456.html',
    updated: timestamp,
    published: timestamp - 86400,
    firstSeen: timestamp,
    materialDate: timestamp,
    details: null,
    enrichedAt: null,
    enrichedUpdated: null,
    enrichmentError: null,
    ...overrides,
  };
}
export const atom = (title = 'SIMATIC S7-1500 update', updated = timestamp) =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>https://cert-portal.siemens.com/productcert/html/ssa-123456.html</id><title>SSA-123456: ${title}</title><updated>${new Date(updated * 1000).toISOString()}</updated><link rel="alternate" href="https://cert-portal.siemens.com/productcert/html/ssa-123456.html"/><summary>&lt;p&gt;Affected controller&lt;/p&gt;</summary></entry></feed>`;
