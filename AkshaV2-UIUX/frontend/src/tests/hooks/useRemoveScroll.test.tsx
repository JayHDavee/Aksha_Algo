import { render, waitFor } from '@testing-library/react';
import React from 'react';
import useRemoveScroll from '../../hooks/useRemoveScroll';

describe('useRemoveScroll', () => {
  const scrollToMock = jest.fn();
  const addClassMock = jest.fn();
  const removeClassMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    // mock scrollTo
    window.scrollTo = scrollToMock as any;

    // only patch methods
    document.body.classList.add = addClassMock as any;
    document.body.classList.remove = removeClassMock as any;
  });

  const TestComponent = ({ deps = [], cssClass }) => {
    useRemoveScroll(deps, cssClass);
    return <div>Test Component</div>;
  };

  it('should call scrollTo(0, 0) on mount', async () => {
    render(<TestComponent deps={[1]} />);

    await waitFor(() => {
      expect(scrollToMock).toHaveBeenCalledWith(0, 0);
    });
  });

  it('should add default "removeScroll" class when deps are empty', async () => {
    render(<TestComponent deps={[]} />);

    await waitFor(() => {
      expect(addClassMock).toHaveBeenCalledWith('removeScroll');
    });
  });

  it('should add custom class if provided and deps are empty', async () => {
    render(<TestComponent deps={[]} cssClass="customScrollBlock" />);

    await waitFor(() => {
      expect(addClassMock).toHaveBeenCalledWith('customScrollBlock');
    });
  });

  it('should not add any class when deps are not empty', async () => {
    render(<TestComponent deps={['not empty']} />);

    await waitFor(() => {
      expect(addClassMock).not.toHaveBeenCalled();
    });
  });

  it('should remove class on unmount', async () => {
    const { unmount } = render(<TestComponent deps={[]} />);
    unmount();

    await waitFor(() => {
      expect(removeClassMock).toHaveBeenCalledWith('removeScroll');
    });
  });

  it('should remove custom class on unmount', async () => {
    const { unmount } = render(<TestComponent deps={[]} cssClass="customScrollBlock" />);
    unmount();

    await waitFor(() => {
      expect(removeClassMock).toHaveBeenCalledWith('customScrollBlock');
    });
  });
});
