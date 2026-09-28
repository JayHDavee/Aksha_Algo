/**
 * Dropdown component
 *
 * Displays a clickable heading and a list of checkbox options in a popover-style dropdown.
 * The dropdown allows selecting multiple labels and updates the parent state via `setSelectedLabels`.
 *
 * - It listens for outside clicks to auto-close the dropdown.
 * - Selected labels are displayed in-line.
 * - The popover behavior and styling assume usage of custom CSS from "Dropdown.scss".
 *
 * ⚠️ Note: Requires `labels.text` to be available in the project. If missing, the component may throw errors.
 */

import React, { useState, useEffect } from "react";
import "./styles/Dropdown.scss";
import { useTranslation } from "react-i18next";

type DropdownProps = {
  heading: string; // Heading text to show on the dropdown button
  active: boolean; // Whether the tab is currently active (used for styling)
  options: string[]; // List of all label options to show in the dropdown
  selectedLabels: string[]; // Currently selected label names
  setSelectedLabels: React.Dispatch<React.SetStateAction<string[]>>; // Setter to update selected labels
  mobile: boolean; // Whether the component is rendered in mobile view
  defaultText?: string;

};

const Dropdown: React.FC<DropdownProps> = ({
  heading,
  active,
  options,
  selectedLabels,
  setSelectedLabels,
  mobile,
}) => {
  const {t} = useTranslation();
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  /**
   * Closes dropdown if a click is detected outside the menu
   */
  useEffect(() => {
    const closeDropdown = (e: any) => {
      const target = e.target as any;
      if (
        target.id !== menuRef.current?.id &&
        target.type !== "checkbox" &&
        target.id !== "selectooi"
      ) {
        setIsOpen(false);
      }
    };

    document.body.addEventListener("click", closeDropdown);
    return () => document.body.removeEventListener("click", closeDropdown);
  }, []);

  /**
   * Toggles dropdown open/close state
   */
  const toggleDropdown = () => {
    setIsOpen((prev) => !prev);
  };

  /**
   * Handles selection/deselection of a label option
   * @param name - Name of the label to toggle
   */
  const handleChange = (name: string) => {
    if (selectedLabels.includes(name)) {
      setSelectedLabels((prev) => prev.filter((val) => val !== name));
    } else {
      setSelectedLabels((prev) => [...prev, name]);
    }
  };

  return (
    <div className="dropdown">
      {/* Header that toggles the dropdown */}
      <div
        className={`inner-content text-center ${active ? "activeTab" : ""}`}
        id="ooi_button"
        ref={menuRef}
        onClick={toggleDropdown}
      >
        {/* Optional heading and asterisk */}
        {!mobile && (
          <p id="selectooi">
            <span id="selectooi">{heading}</span>
            <span className="asterics_style">* </span>
          </p>
        )}

        {/* Selected labels or default text */}
        <p className="text-label mb-0 paragah" id="selectooi">
          {selectedLabels.length > 0 ? (
            selectedLabels.map((label, idx) => (
              <span key={`${label}-${idx}`} id="selectooi">
                {`${label}${selectedLabels.length !== idx + 1 ? ", " : ""}`}
              </span>
            ))
          ) : (
            <span id="selectooi">{t("select objects")}</span>
          )}
        </p>
      </div>

      {/* Dropdown content */}
      {isOpen && (
        <ul className="dropdown-menu" id="checkbox_menu">
          {options.map((item, index) => (
            <li key={`${item}-${index}`} id="selectooi">
              <div
                className="form-check"
                id="selectooi"
                onClick={() => handleChange(item)}
              >
                <input
                  type="checkbox"
                  className="form-check-input"
                  checked={selectedLabels.includes(item)}
                  readOnly
                  id="selectooi"
                />
                <label
                  className="form-check-label"
                  style={{ fontSize: 18 }}
                  id="selectooi"
                >
                  {item}
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default Dropdown;