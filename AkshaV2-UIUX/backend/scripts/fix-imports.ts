import fs from 'fs';
import path from 'path';

const fixImports = (filePath: string): void => {
  const content = fs.readFileSync(filePath, 'utf8');
  
  // Fix common import patterns
  let newContent = content
    // Fix fs import
    .replace(/import fs from ['"]fs['"];/, `import * as fs from 'fs';`)
    // Fix path import
    .replace(/import path from ['"]path['"];/, `import * as path from 'path';`)
    // Fix http import
    .replace(/import http from ['"]http['"];/, `import * as http from 'http';`)
    // Fix crypto import
    .replace(/import crypto from ['"]crypto['"];/, `import * as crypto from 'crypto';`)
    // Fix express import
    .replace(/import express from ['"]express['"];/, `import * as express from 'express';\nconst { Router } = express;`)
    // Fix moment import
    .replace(/import moment from ['"]moment['"];/, `import * as moment from 'moment';`)
    // Fix cors import
    .replace(/import cors from ['"]cors['"];/, `import * as cors from 'cors';`);

  // Write back to file if content changed
  if (content !== newContent) {
    fs.writeFileSync(filePath, newContent);
    console.log(`Fixed imports in ${filePath}`);
  }
};

const processDirectory = (dir: string): void => {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      processDirectory(fullPath);
    } else if (file.endsWith('.ts')) {
      fixImports(fullPath);
    }
  }
};

// Process src and utils directories
const directories = [
  path.join(__dirname, '..', 'src'),
  path.join(__dirname, '..', 'utils')
];

directories.forEach(dir => {
  if (fs.existsSync(dir)) {
    processDirectory(dir);
  }
});

console.log('Import statements have been fixed in all TypeScript files.');
