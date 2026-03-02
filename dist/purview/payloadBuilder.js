"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPurviewPayload = buildPurviewPayload;
const github = __importStar(require("@actions/github"));
const crypto_1 = require("crypto");
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
        Id: (0, crypto_1.randomUUID)(),
        ContentType: 0, // 0 for Raw text/base64
        Content: payload.content,
    };
}
function buildPurviewPayload(filePayloads, config) {
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