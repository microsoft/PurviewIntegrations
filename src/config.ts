import * as core from '@actions/core';
import { ActionConfig } from './utils/types';

export function getConfig(): ActionConfig {
  const includeGlobs = core.getInput('include-globs', { required: true }).split(/[\s,]+/).filter(Boolean);
  const excludeGlobs = core.getInput('exclude-globs', { required: false }).split(/[\s,]+/).filter(Boolean);
  const applicationHostCategories = core.getInput('application-host-categories', { required: false }).split(',').map(c => c.trim()).filter(Boolean);

  const maxFileBytes = parseInt(core.getInput('max-file-bytes', { required: true }), 10);
  if (isNaN(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error('Input "max-file-bytes" must be a positive number.');
  }

  return {
    endpoint: core.getInput('endpoint', { required: true }),
    userPrincipalName: core.getInput('user-principal-name', { required: true }),
    tenantId: core.getInput('tenant-id', { required: true }),
    aadResource: core.getInput('aad-resource', { required: true }),
    includeGlobs: includeGlobs.length > 0 ? includeGlobs : ['**/*'],
    excludeGlobs,
    maxFileBytes,
    sliceLargeFiles: core.getBooleanInput('slice-large-files', { required: true }),
    skipBinary: core.getBooleanInput('skip-binary', { required: true }),
    includeSummaryPayload: core.getBooleanInput('include-summary-payload', { required: true }),
    minify: core.getBooleanInput('minify', { required: true }),
    failOnNon2xx: core.getBooleanInput('fail-on-non-2xx', { required: true }),
    appHostName: core.getInput('app-host-name', { required: true }),
    applicationHostCategories,
    debug: core.getBooleanInput('debug-logs', { required: true }),
  };
}