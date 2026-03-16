import * as github from '@actions/github';
import { randomUUID } from 'crypto';
function createParticipant(config) {
    return {
        tenantId: config.tenantId,
        displayName: config.userPrincipalName.split('@')[0] || '', // Best effort display name from UPN
        recipientType: 0, // 0 for User
        userPrincipalName: config.userPrincipalName,
    };
}
function createFileContent(payload) {
    return {
        Id: randomUUID(),
        ContentType: 0, // 0 for Raw text/base64
        Content: payload.content,
    };
}
export function buildPurviewPayload(filePayloads, config) {
    const now = new Date().toISOString();
    const participant = createParticipant(config);
    const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_REF_NAME } = process.env;
    const messages = filePayloads.map((fp, index) => {
        return {
            timestamp: now,
            lastModifiedDate: now,
            messageLocale: 'en-US',
            messageClientIp: '',
            messageId: index, // Simple index within the batch
            messageType: 1, // 1 for Standard
            messageFrom: participant,
            content: [createFileContent(fp)],
            reaction: '',
            accessedResources: [],
            modelInfo: { modelProviderName: '', modelName: '', modelVersion: '' },
            deviceInfo: {
                deviceManagementType: 0,
                deviceType: 'PC',
                operatingSystemPlatform: 'Service',
                operatingSystemVersion: '',
            },
        };
    });
    const messageGroup = {
        messageGroupId: `${github.context.runId}-${github.context.runAttempt}`,
        messageGroupSubject: `Commit ${GITHUB_SHA?.slice(0, 7)} to ${GITHUB_REPOSITORY} on branch ${GITHUB_REF_NAME}`,
        messageGroupTenantId: config.tenantId,
        messages: messages,
        appHostInfo: {
            AppHostName: config.appHostName,
            ChildAppHostName: '',
            AppHostFQDN: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}`,
            AppHostVersion: '1.0.0', // Version of this action
            ApplicationHostCategories: config.applicationHostCategories,
        },
        messageGroupParticipants: [participant],
    };
    const payload = {
        clientInfo: {
            clientName: 'purview-github-action',
            version: '1.0',
            ClientIp: '', // Left blank for service-to-service
        },
        messageGroups: [messageGroup],
    };
    return payload;
}
//# sourceMappingURL=payloadBuilder.js.map