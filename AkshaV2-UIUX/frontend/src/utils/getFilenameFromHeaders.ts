// src/utils/getFilenameFromHeaders.ts

const getFilenameFromHeaders = (headers: { [key: string]: any }): string => {
  const contentDisposition = headers['content-disposition'];
  const defaultFilename = `chat_history_${new Date().toISOString()}.zip`;

  if (!contentDisposition) {
    return defaultFilename;
  }

  // Extract filename="example.zip" OR filename='example.zip' OR filename=example.zip
  const match = contentDisposition.match(/filename=(?:["']?)([^"';]+)(?:["']?)/);

  if (match && match[1]) {
    return match[1];
  }

  return defaultFilename;
};

export default getFilenameFromHeaders;
