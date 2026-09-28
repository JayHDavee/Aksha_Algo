import * as React from 'react';
import Popover from '@mui/material/Popover';
import Typography from '@mui/material/Typography';
import CanvasDraw from "../../common/CanvasDraw"; // Assuming CanvasDraw is a TSX component
import { useSelector } from "react-redux";

// --- Interfaces for Type Safety ---

/**
 * Interface for the props passed to the AreaOfInterest component.
 * @interface AreaOfInterestProps
 */
interface AreaOfInterestProps {
  heading: string; // Text for the header (e.g., "Area of Interest")
  text: string; // Text displayed within the tab (e.g., "AOI")
  active: boolean; // Boolean indicating if the tab is currently active (for styling)
  index: number; // Index of this tab within a parent array (e.g., `searchStore`)
  onChangeActiveCss: (index: number) => void; // Callback to update active CSS in parent's tab array
  setAIPolygen: (polygonData: any) => void; // Callback to set Area of Interest polygon data in parent component
  mobile: boolean; // Boolean to conditionally render elements for mobile vs. desktop view
}

/**
 * Interface for the relevant part of the Redux state accessed by `useSelector`.
 * @interface RootState
 */
interface RootState {
  investigation: {
    areaOfInterestImage: string | null; // The URL of the image on which the user draws the AOI
    // Add other relevant states from investigationReducer if accessed
  };
  // Add other top-level slices of your Redux store if accessed
}

// --- Main Component ---

/**
 * `AreaOfInterest` component displays a clickable text element which, when clicked,
 * opens a popover. Inside this popover, a `CanvasDraw` component is rendered,
 * allowing the user to draw an Area of Interest (AOI) on a camera image.
 * The image for drawing is fetched from the Redux store.
 *
 * @param {AreaOfInterestProps} props - The properties passed to the component.
 * @returns {JSX.Element} The rendered AreaOfInterest component.
 */
function AreaOfInterest({
  heading,
  text,
  active,
  index,
  onChangeActiveCss,
  setAIPolygen,
  mobile,
}: AreaOfInterestProps): any {

  // State to control the anchor element for the Popover.
  // When `anchorEl` is not null, the Popover is open and anchored to this element.
  const [anchorEl, setAnchorEl] = React.useState<HTMLDivElement | null>(null);

  // Redux state: Retrieves the Area of Interest image URL from the Redux store.
  // This image is passed to the `CanvasDraw` component for user interaction.
  const areaOfInterestImage: any = useSelector(
    (state: RootState) => state.investigation.areaOfInterestImage
  );

  /**
   * Handles the click event to open the Popover.
   * Sets the `anchorEl` to the current target element, which triggers the Popover to open.
   * Also calls `onChangeActiveCss` to update the active styling of the tab.
   * @param {React.MouseEvent<HTMLDivElement>} event - The mouse event from the clickable div.
   * @function handleClick
   */
  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    setAnchorEl(event.currentTarget);
  };

  /**
   * Handles the event to close the Popover.
   * Sets `anchorEl` back to `null`, which causes the Popover to close.
   * @function handleClose
   */
  const handleClose = (): void => {
    setAnchorEl(null);
  };

  // Derived state for Popover properties:
  // `open` is a boolean indicating if the Popover should be visible.
  // `id` provides a unique identifier for accessibility purposes (required by MUI Popover).
  const open: boolean = Boolean(anchorEl);
  const id: string | undefined = open ? 'simple-popover' : undefined;

  return (
    <div>
      {/* Clickable div that acts as the trigger for the Popover */}
      <div
        className={`inner-content text-center ${active ? "activeTab" : ""}`} // Apply 'activeTab' class if `active` prop is true
        key={index} // Unique key for list rendering (though this component seems to be a single instance)
        onClick={(e) => {
          handleClick(e); // Open the popover
          onChangeActiveCss(index); // Update parent's tab active state
        }}
      >
        {/* Display heading for desktop view only */}
        {mobile === false && <p className="heading mb-1">{heading}</p>}
        {/* Display main text label */}
        <p className="text-label mb-0">{text}</p>
      </div>

      {/* MUI Popover component */}
      <Popover
        id={id} // Unique ID for accessibility
        open={open} // Controls visibility of the popover
        anchorEl={anchorEl} // Element to which the popover is anchored
        onClose={handleClose} // Callback to close the popover when clicking outside or pressing Escape
        anchorOrigin={{
          vertical: "bottom", // Popover's vertical origin point relative to anchor
          horizontal: "left", // Popover's horizontal origin point relative to anchor
        }}
        className="model-radius" // Custom class for styling the popover container (likely for border-radius)
      >
        <Typography sx={{ p: 1 }}> {/* MUI System prop for padding */}
          {/* Render CanvasDraw component inside the popover. */}
          {/* It allows users to draw on the `areaOfInterestImage`. */}
          {/* `setAIPolygen` callback passes the drawn polygon data back to the parent. */}
          {/* Fixed width and height are passed for the canvas. */}
          <CanvasDraw
            imageUrl={areaOfInterestImage}
            setAIPolygen={setAIPolygen}
            width={500}
            height={360}
          />
        </Typography>
      </Popover>
    </div>
  );
}

// Memoize the component for performance optimization.
// This prevents unnecessary re-renders if props haven't changed.
export default React.memo(AreaOfInterest);