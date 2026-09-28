
import getFilenameFromHeaders from '../../utils/getFilenameFromHeaders';

const defaultRegex = /^chat_history_\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.zip$/;

describe('getFilenameFromHeaders', () => {
 it('should extract filename from content-disposition header with filename', () => {
 const headers = {
 'content-disposition': 'attachment; filename="example.zip"',
 };
 expect(getFilenameFromHeaders(headers)).toBe('example.zip');
 });


 it('should extract filename from content-disposition header with single quotes', () => {
 const headers = {
 'content-disposition': "attachment; filename='single-quotes.zip'",
 };
 expect(getFilenameFromHeaders(headers)).toBe('single-quotes.zip');
 });


 it('should handle content-disposition header without filename', () => {
 const headers = {
 'content-disposition': 'attachment',
 };
 const filename = getFilenameFromHeaders(headers);
expect(filename).toMatch(defaultRegex);
 });


 it('should return default filename when content-disposition header is missing', () => {
 const headers = {};
 const filename = getFilenameFromHeaders(headers);
expect(filename).toMatch(defaultRegex);
 });


 it('should return default filename when filename regex fails', () => {
 const headers = {
 'content-disposition': 'attachment; filename*=UTF-8\'\'My%20File.zip',
 };
 const filename = getFilenameFromHeaders(headers);
expect(filename).toMatch(defaultRegex);
 });
});
