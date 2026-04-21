#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListResourceTemplatesRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { codexDoctorReport } from "../../commands/codex-doctor.js";
async function main() {
    const server = new Server({ name: 'agent-awareness-codex', version: '0.1.0' }, {
        capabilities: {
            tools: {},
            resources: {},
        },
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [],
    }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
        resourceTemplates: [],
    }));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{
                name: 'awareness_doctor',
                description: 'Diagnose agent-awareness Codex integration health',
                inputSchema: { type: 'object', properties: {} },
            }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name !== 'awareness_doctor') {
            return {
                content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
                isError: true,
            };
        }
        const report = await codexDoctorReport();
        return { content: [{ type: 'text', text: report.text }] };
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch(err => {
    console.error('[agent-awareness-codex-mcp] fatal:', err);
    process.exit(1);
});
