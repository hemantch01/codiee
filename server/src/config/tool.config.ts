import { google } from '@ai-sdk/google';
import chalk from 'chalk';

/**
 * Available Google Generative AI tools configuration
 * Note: Tools are instantiated lazily to avoid initialization errors
 */
interface ToolConfig {
  id: string;
  name: string;
  description: string;
  getTool: () => any;
  enabled: boolean;
}

export const availableTools: ToolConfig[] = [
  {
    id: 'google_search',
    name: 'Google Search',
    description: 'Access the latest information using Google search. Useful for current events, news, and real-time information.',
    getTool: () => google.tools.googleSearch({}),
    enabled: false,
  },
  {
    id: 'code_execution',
    name: 'Code Execution',
    description: 'Generate and execute Python code to perform calculations, solve problems, or provide accurate information.',
    getTool: () => google.tools.codeExecution({}),
    enabled: false,
  },
  {
    id: 'url_context',
    name: 'URL Context',
    description: 'Provide specific URLs that you want the model to analyze directly from the prompt. Supports up to 20 URLs per request.',
    getTool: () => google.tools.urlContext({}),
    enabled: false,
  },
];

/**
 * Get enabled tools as a tools object for AI SDK
 */
export function getEnabledTools(): Record<string, any> | undefined {
  const tools: Record<string, any> = {};

  try {
    for (const toolConfig of availableTools) {
      if (toolConfig.enabled) {
        // Instantiate the tool when needed
        tools[toolConfig.id] = toolConfig.getTool();
      }
    }

    return Object.keys(tools).length > 0 ? tools : undefined;
  } catch (error) {
    console.error(chalk.red('[ERROR] Failed to initialize tools:'), error.message);
    console.error(chalk.yellow('Make sure you have @ai-sdk/google version 2.0+ installed'));
    console.error(chalk.yellow('Run: npm install @ai-sdk/google@latest'));
    return undefined;
  }
}

/**
 * Enable specific tools
 */
export function enableTools(toolIds: string[]): void {
  availableTools.forEach(tool => {
    tool.enabled = toolIds.includes(tool.id);
  });
}

/**
 * Get all enabled tool names
 */
export function getEnabledToolNames(): string[] {
  return availableTools.filter(t => t.enabled).map(t => t.name);
}

/**
 * Reset all tools (disable all)
 */
export function resetTools() {
  availableTools.forEach(tool => {
    tool.enabled = false;
  });
}