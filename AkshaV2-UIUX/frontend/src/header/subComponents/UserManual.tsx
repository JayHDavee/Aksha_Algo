import React from 'react';
import Modal from 'react-bootstrap/Modal';

// Define the prop types for the UserManual component
interface UserManualProps {
  value: boolean;               // Controls whether the modal is shown
  onModalClose: () => void;     // Function to close the modal
}

// Define the URL to the user manual PDF
const PDF_URL = 'https://aksha-storage.s3.ap-south-1.amazonaws.com/aksha-resources/Aksha_V2_User_Manual.pdf';

/**
 * UserManual Component
 * Displays a modal containing an embedded PDF user manual.
 */
const UserManual: React.FC<UserManualProps> = ({ value, onModalClose }) => (
  <Modal
    show={value}               // Show the modal when `value` is true
    onHide={onModalClose}      // Trigger `onModalClose` when modal is dismissed
    dialogClassName="user-manual" // Custom class for modal styling
  >
    {/* Modal Header */}
    <Modal.Header closeButton>
      <Modal.Title>User Manual</Modal.Title>
    </Modal.Header>

    {/* Modal Body: PDF viewer */}
    <div className="pdf-outer-style">
      <iframe
        src={PDF_URL}               // Embedded PDF source
        frameBorder="0"             // No border for iframe
        scrolling="auto"            // Allow scroll if needed
        height="550px"              // Fixed height for PDF display
        width="100%"                // Full width of container
        title="Aksha User Manual"   // Accessibility title
        style={{ marginTop: '10%' }}// Top margin styling
      />
    </div>
  </Modal>
);

export default UserManual;
