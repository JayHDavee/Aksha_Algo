// src/tests/container/cameraDirectory/List/Edit.test.tsx
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import Edit from '../../../../container/cameraDirectory/List/Edit';
import { MemoryRouter } from 'react-router-dom';

// -------------------------------
// Clean DOM after each test
// -------------------------------
afterEach(() => cleanup());

// -------------------------------
// Mock envHelper
// -------------------------------
jest.mock('../../../../utils/envHelper', () => ({
  getEnvVar: jest.fn(() => 'http://localhost:5000'),
}));

// -------------------------------
// Mock konva / canvas dependency
// -------------------------------
jest.mock('konva', () => {
  return {
    Stage: (props: any) => <div {...props} />,
    Layer: (props: any) => <div {...props} />,
    Rect: (props: any) => <div {...props} />,
    Circle: (props: any) => <div {...props} />,
    Line: (props: any) => <div {...props} />,
  };
});

// -------------------------------
// Tests
// -------------------------------
describe('Edit Component', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <MemoryRouter>
        <Edit />
      </MemoryRouter>
    );

    const section = container.querySelector('.camera-directory-list-section');
    expect(section).toBeInTheDocument();
  });
});
