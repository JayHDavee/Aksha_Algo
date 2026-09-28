export const io = jest.fn(() => ({
  on: jest.fn(),
  emit: jest.fn(),
  disconnect: jest.fn(),
}));

export type Socket = ReturnType<typeof io>;
