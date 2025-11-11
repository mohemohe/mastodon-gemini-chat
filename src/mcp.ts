import { McpStdioServerAdapter } from '@langchain/mcp-adapters';
import fs from 'node:fs';
import path from 'node:path';

export interface McpConfig {
  mcpServers: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
}

let mcpAdapter: McpStdioServerAdapter | null = null;
let isInitialized = false;

/**
 * Load MCP configuration from data/mcp.json
 */
function loadMcpConfig(): McpConfig | null {
  const configPath = path.join(process.cwd(), 'data', 'mcp.json');
  
  try {
    if (!fs.existsSync(configPath)) {
      console.log('MCP config file not found at data/mcp.json - skipping MCP initialization');
      return null;
    }
    
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData) as McpConfig;
    
    if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
      console.log('No MCP servers configured in mcp.json - skipping MCP initialization');
      return null;
    }
    
    return config;
  } catch (error) {
    console.error('Error loading MCP config:', error);
    return null;
  }
}

/**
 * Initialize MCP adapter if configuration exists
 */
export async function initializeMcp(): Promise<McpStdioServerAdapter | null> {
  if (isInitialized) {
    return mcpAdapter;
  }
  
  const config = loadMcpConfig();
  if (!config) {
    isInitialized = true;
    return null;
  }
  
  try {
    console.log('Initializing MCP adapter...');
    
    // For now, initialize with the first configured server
    // In a more complex implementation, you might want to support multiple servers
    const serverNames = Object.keys(config.mcpServers);
    const firstServerName = serverNames[0];
    const serverConfig = config.mcpServers[firstServerName];
    
    console.log(`Connecting to MCP server: ${firstServerName}`);
    
    mcpAdapter = new McpStdioServerAdapter({
      command: serverConfig.command,
      args: serverConfig.args || [],
      env: serverConfig.env || {},
    });
    
    await mcpAdapter.connect();
    console.log(`Successfully connected to MCP server: ${firstServerName}`);
    
    isInitialized = true;
    return mcpAdapter;
  } catch (error) {
    console.error('Failed to initialize MCP adapter:', error);
    mcpAdapter = null;
    isInitialized = true;
    return null;
  }
}

/**
 * Get the initialized MCP adapter
 */
export function getMcpAdapter(): McpStdioServerAdapter | null {
  return mcpAdapter;
}

/**
 * Check if MCP is available and initialized
 */
export function isMcpAvailable(): boolean {
  return mcpAdapter !== null;
}

/**
 * Cleanup MCP connections
 */
export async function cleanupMcp(): Promise<void> {
  if (mcpAdapter) {
    try {
      await mcpAdapter.close();
      console.log('MCP adapter disconnected');
    } catch (error) {
      console.error('Error disconnecting MCP adapter:', error);
    }
    mcpAdapter = null;
  }
}