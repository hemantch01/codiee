import { promises as fs } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { generateObject } from 'ai';
import { z } from 'zod';

/**
 * Zod schema for structured application generation
 */
const ApplicationSchema = z.object({
  folderName: z.string().describe('Kebab-case folder name for the application'),
  description: z.string().describe('Brief description of what was created'),
  files: z.array(
    z.object({
      path: z.string().describe('Relative file path (e.g., src/App.jsx)'),
      content: z.string().describe('Complete file content'),
    })
  ).describe('All files needed for the application'),
  setupCommands: z.array(z.string()).describe('Bash commands to setup and run (e.g., npm install, npm run dev)'),
});

/**
 * Console logging helpers
 */

/**
 * Display file tree structure
 */
function displayFileTree(files, folderName) {
  console.log(chalk.cyan('\n📂 Project Structure:'));
  console.log(chalk.white(`${folderName}/`));
  
  const filesByDir = {};
  files.forEach(file => {
    const parts = file.path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    
    if (!filesByDir[dir]) {
      filesByDir[dir] = [];
    }
    filesByDir[dir].push(parts[parts.length - 1]);
  });
  
  Object.keys(filesByDir).sort().forEach(dir => {
    if (dir) {
      console.log(chalk.white(`├── ${dir}/`));
      filesByDir[dir].forEach(file => {
        console.log(chalk.white(`│   └── ${file}`));
      });
    } else {
      filesByDir[dir].forEach(file => {
        console.log(chalk.white(`├── ${file}`));
      });
    }
  });
}

/**
 * Create application files
 */
async function createApplicationFiles(
  baseDir: string,
  folderName: string,
  files: { path: string; content: string }[]
): Promise<string> {
  const appDir = path.join(baseDir, folderName);
  
  await fs.mkdir(appDir, { recursive: true });
  console.log(chalk.cyan(`\n📁 Created directory: ${folderName}/`));
  
  for (const file of files) {
    const filePath = path.join(appDir, file.path);
    const fileDir = path.dirname(filePath);
    
    await fs.mkdir(fileDir, { recursive: true });
    await fs.writeFile(filePath, file.content, 'utf8');
    console.log(chalk.green(`  ✓ ${file.path}`));
  }
  
  return appDir;
}

/** Generate an application via structured output. `projectInsight` carries
 * RAG-retrieved excerpts of the user's existing project so generated code
 * fits their stack. */
export async function generateApplication(
  description: string,
  aiService: any,
  cwd: string = process.cwd(),
  projectInsight: string | null = null
): Promise<{ success: boolean; commands: string[] }> {
  try {
    console.log(chalk.cyan('\n🤖 Agent Mode: Generating your application...\n'));
    console.log(chalk.gray(`Request: ${description}\n`));
    
    console.log(chalk.magenta('🤖 Generating structured output...\n'));
    

    const result = await generateObject({
      model: aiService.model,
      schema: ApplicationSchema,
      prompt: `Create a complete, production-ready application for: ${description}

${projectInsight ? `CONTEXT FROM THE USER'S EXISTING PROJECT:
The user ran this inside an existing codebase. These are real excerpts retrieved from it:

${projectInsight}

IMPORTANT:
- Match the tech stack, framework versions and conventions visible above whenever relevant.
- Reuse existing patterns/utilities shown above instead of inventing new ones.
- If the request is about adding a feature to this project (e.g. a login page), generate files that fit INTO this structure with consistent naming.
- If the excerpt content is not relevant to the request, ignore it.

` : ''}CRITICAL REQUIREMENTS:
1. Generate ALL files needed for the application to run
2. Include package.json with ALL dependencies and correct versions (if needed)
3. Include README.md with setup instructions
4. Include configuration files (.gitignore, etc.) if needed
5. Write clean, well-commented, production-ready code
6. Include error handling and input validation
7. Use modern JavaScript/TypeScript best practices
8. Make sure all imports and paths are correct
9. NO PLACEHOLDERS - everything must be complete and working
10. For simple HTML/CSS/JS projects, you can skip package.json if not needed

Provide:
- A meaningful kebab-case folder name
- All necessary files with complete content
- Setup commands (for example: cd folder, npm install, npm run dev OR just open index.html)
- Make it visually appealing and functional`,
    });
    
    const application = result.object as {
      folderName: string;
      description: string;
      files: { path: string; content: string }[];
      setupCommands: string[];
    };
    
    console.log(chalk.green(`\n✅ Generated: ${application.folderName}\n`));
    console.log(chalk.gray(`Description: ${application.description}\n`));
    
    if (!application.files || application.files.length === 0) {
      throw new Error('No files were generated');
    }
    
    console.log(chalk.green(`Files: ${application.files.length}\n`));

    displayFileTree(application.files, application.folderName);

    console.log(chalk.cyan('\n📝 Creating files...\n'));
    const appDir = await createApplicationFiles(cwd, application.folderName, application.files);

    console.log(chalk.green.bold(`\n✨ Application created successfully!\n`));
    console.log(chalk.cyan(`📁 Location: ${chalk.bold(appDir)}\n`));

    if (application.setupCommands && application.setupCommands.length > 0) {
      console.log(chalk.cyan('📋 Next Steps:\n'));
      console.log(chalk.white('```bash'));
      application.setupCommands.forEach(cmd => {
        console.log(chalk.white(cmd));
      });
      console.log(chalk.white('```\n'));
    } else {
      console.log(chalk.yellow('ℹ️  No setup commands provided\n'));
    }
    
    return {
      success: true,
      commands: application.setupCommands || [],
    };
    
  } catch (err) {
    console.log(chalk.red(`\n❌ Error generating application: ${err.message}\n`));
    if (err.stack) {
      console.log(chalk.dim(err.stack + '\n'));
    }
    throw err;
  }
}