import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import fs from 'node:fs';
import path from 'node:path';

export interface McpConfig {
  mcpServers: Record<string, {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    transport?: string;
    url?: string;
    headers?: Record<string, string>;
  }>;
}

let mcpClient: MultiServerMCPClient | null = null;
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
 * Initialize MCP client if configuration exists
 */
export async function initializeMcp(): Promise<MultiServerMCPClient | null> {
  if (isInitialized) {
    return mcpClient;
  }

  const config = loadMcpConfig();
  if (!config) {
    isInitialized = true;
    return null;
  }

  try {
    console.log('Initializing MCP client...');

    // Transform config to match MultiServerMCPClient format
    const serverConfigs: Record<string, any> = {
      mcpServers: config.mcpServers,
    };

    console.log(`Connecting to ${Object.keys(serverConfigs).length} MCP servers`);

    mcpClient = new MultiServerMCPClient(serverConfigs);

    try {
      // Initialize connections by getting tools
      await mcpClient.getTools();
      console.log('Successfully connected to MCP servers');
    } catch (error) {
      console.warn('Some MCP servers failed to connect, but client is available:', error);
      // Don't fail completely - allow partial functionality
    }

    isInitialized = true;
    return mcpClient;
  } catch (error) {
    console.error('Failed to initialize MCP client:', error);
    mcpClient = null;
    isInitialized = true;
    return null;
  }
}

/**
 * Get the initialized MCP client
 */
export function getMcpClient(): MultiServerMCPClient | null {
  return mcpClient;
}

/**
 * Get the initialized MCP adapter (for backward compatibility)
 */
export function getMcpAdapter(): MultiServerMCPClient | null {
  return mcpClient;
}

/**
 * Check if MCP is available and initialized
 */
export function isMcpAvailable(): boolean {
  return mcpClient !== null;
}

/**
 * Cleanup MCP connections
 */
export async function cleanupMcp(): Promise<void> {
  if (mcpClient) {
    try {
      await mcpClient.close();
      console.log('MCP client disconnected');
    } catch (error) {
      console.error('Error disconnecting MCP client:', error);
    }
    mcpClient = null;
  }
}
