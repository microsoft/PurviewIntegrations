import * as core from '@actions/core';
import { ConfidentialClientApplication, ClientCredentialRequest } from '@azure/msal-node';
import { X509Certificate, createHash } from 'crypto';
import { ActionConfig, AuthToken } from '../config/types';
import { Logger } from '../utils/logger';

export class AuthenticationService {
  private readonly logger: Logger;
  private readonly msalApp: ConfidentialClientApplication;
  private cachedToken: AuthToken | null = null;
  private readonly authMode: 'certificate' | 'clientSecret' | 'federated';
  
  constructor(private readonly config: ActionConfig) {
    this.logger = new Logger('AuthenticationService');

    const authority = `https://login.microsoftonline.com/${this.config.tenantId}`;
    const clientCertificatePem = this.config.clientCertificatePem?.trim();

    if (clientCertificatePem) {
      const clientCertificate = this.buildClientCertificateConfig(clientCertificatePem);
      this.authMode = 'certificate';
      this.logger.info('Authentication mode: certificate');

      this.msalApp = new ConfidentialClientApplication({
        auth: {
          clientId: this.config.clientId,
          authority,
          clientCertificate
        }
      });
    } else if (this.config.clientSecret) {
      this.authMode = 'clientSecret';
      this.logger.info('Authentication mode: client-secret');

      this.msalApp = new ConfidentialClientApplication({
        auth: {
          clientId: this.config.clientId,
          authority,
          clientSecret: this.config.clientSecret
        }
      });
    } else {
      this.authMode = 'federated';
      this.logger.info('Authentication mode: federated (GitHub OIDC)');

      // Initialize MSAL application with federated credential configuration
      this.msalApp = new ConfidentialClientApplication({
        auth: {
          clientId: this.config.clientId,
          authority,
          clientAssertion: this.getClientAssertion.bind(this)
        }
      });
    }
  }
  
  async getToken(): Promise<AuthToken> {
    try {
      // Check cached token
      if (this.cachedToken && this.isTokenValid(this.cachedToken)) {
        this.logger.debug('Using cached token');
        return this.cachedToken;
      }

      this.logger.info(`Acquiring new token using MSAL (${this.authMode})`);
      
      let scope = URL.parse(this.config.purviewEndpoint)?.host ?? "graph.microsoft.com";

      // Configure client credential request
      const clientCredentialRequest: ClientCredentialRequest = {
        scopes: [`https://${scope}/.default`],
      };
      
      // Acquire token using client credentials flow with federated credential
      const response = await this.msalApp.acquireTokenByClientCredential(clientCredentialRequest);
      
      if (!response || !response.accessToken) {
        throw new Error('Failed to acquire token from MSAL');
      }
      
      // Create AuthToken from MSAL response
      const authToken: AuthToken = {
        accessToken: response.accessToken,
        expiresAt: response.expiresOn || new Date(Date.now() + 3600000) // fallback to 1 hour
      };
      
      // Cache the token
      this.cachedToken = authToken;
      this.logger.info('Token acquired successfully using MSAL');
      
      return authToken;
    } catch (error) {
      this.logger.error('Authentication failed', { error });
      throw new Error(`Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  private async getClientAssertion(): Promise<string> {
    try {
      if (this.authMode !== 'federated') {
        throw new Error('Client assertion requested while not in federated auth mode');
      }

      // Get GitHub OIDC token to use as federated credential
      this.logger.debug('Acquiring GitHub OIDC token for federated credential');
      const audience = "api://AzureADTokenExchange";
      
      const oidcToken = await core.getIDToken(audience);
      if (!oidcToken) {
        throw new Error('Failed to get OIDC token from GitHub Actions');
      }
      
      this.logger.debug('GitHub OIDC token acquired successfully');
      return oidcToken;
    } catch (error) {
      this.logger.error('Failed to get client assertion', { error });
      throw new Error(`Failed to get federated credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  private isTokenValid(token: AuthToken): boolean {
    const bufferMinutes = 5;
    const expiryWithBuffer = new Date(token.expiresAt.getTime() - (bufferMinutes * 60 * 1000));
    return new Date() < expiryWithBuffer;
  }
  
  /**
   * Clear the cached token to force refresh on next request
   */
  public clearCache(): void {
    this.cachedToken = null;
    this.logger.debug('Token cache cleared');
  }

  private buildClientCertificateConfig(pem: string): { thumbprint: string; privateKey: string } {
    const privateKey = this.extractPemBlock(pem, /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/m, 'PRIVATE KEY');
    const certificate = this.extractPemBlock(pem, /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/m, 'CERTIFICATE');

    const x509 = new X509Certificate(certificate);
    const thumbprint = createHash('sha1').update(x509.raw).digest('hex').toUpperCase();

    return {
      thumbprint,
      privateKey
    };
  }

  private extractPemBlock(pem: string, pattern: RegExp, label: string): string {
    const match = pem.match(pattern);
    if (!match || !match[0]) {
      throw new Error(`client-certificate is missing a ${label} PEM block`);
    }
    return match[0].trim();
  }
}