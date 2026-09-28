import React from 'react';
import { render, screen } from '@testing-library/react'; // Import 'screen' for getByTestId
import userEvent from '@testing-library/user-event';
import ImageModel from '../../../component/common/ImageModel';

describe('ImageModel Component', () => {
  const mockSetOpen = jest.fn();

  it('renders without crashing when open', () => {
    const { getByAltText } = render(
      <ImageModel open={true} setOpen={mockSetOpen} imgUrl="test-image.jpg" />
    );
    expect(getByAltText('camera img')).toBeInTheDocument();
  });

  it('does not render image when imgUrl is empty', () => {
    const { queryByAltText } = render(
      <ImageModel open={true} setOpen={mockSetOpen} imgUrl="" />
    );
    expect(queryByAltText('camera img')).toBeNull();
  });

  // FIX: Use getByTestId('CloseRoundedIcon') instead of getByRole('button')
  it('calls setOpen(false) when close icon is clicked', async () => { 
    render(
      <ImageModel open={true} setOpen={mockSetOpen} imgUrl="test-image.jpg" />
    );
    
    // The DOM snapshot showed the icon has data-testid="CloseRoundedIcon". 
    // We use this to reliably select the element we want to click.
    const closeIcon = screen.getByTestId('CloseRoundedIcon'); 
    
    // We use await with userEvent.click as it handles potential asynchronous updates.
    await userEvent.click(closeIcon); 
    
    expect(mockSetOpen).toHaveBeenCalledWith(false);
  });
});