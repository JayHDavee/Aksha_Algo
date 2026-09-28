import React, { useState, useEffect, useRef, RefObject, useTransition } from "react";
import Popover from '@mui/material/Popover';
import Typography from '@mui/material/Typography';
import TruckModel from "./TruckModel";
import './styles/asteric.css';
import './styles/Truck.scss';
import { useTranslation, UseTranslationResponse } from "react-i18next";

// Define the props interface for the Truck component
interface TruckProps {
  heading: string;                          // Heading text for the dropdown
  text: string | string[];                  // Text or array of texts for labels
  active: boolean;                          // Whether this tab is active
  index: number;                            // Index of this tab in the tab store
  setTabStore: React.Dispatch<React.SetStateAction<any[]>>; // Setter for tab store state
  tabStore: any[];                          // Current tab store state
  setOILable: (labels: string[]) => void;  // Function to update selected labels in parent
  mobile: boolean;                          // Whether in mobile view
  ooiLabels: string[];                      // List of object of interest labels
  isOpen: boolean;                          // Whether the dropdown is open
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>; // Setter for dropdown open state
  menuRef: any;      // Ref to the dropdown menu element
}

// Truck component shows a dropdown with checkboxes inside a popover
export default function Truck({
  heading,
  text,
  active,
  index,
  setTabStore,
  tabStore,
  setOILable,
  mobile,
  ooiLabels,
  isOpen,
  setIsOpen,
  menuRef,
}: TruckProps) {

  // State for anchor element of the popover
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  // State for default value (currently unused)
  const [defaultval, setDefaultval] = useState<string>("");
  // State for checked items in the dropdown, keyed by item id
  const [checkedItems, setCheckedItems] = useState<{ [key: number]: boolean }>({});
  // State for selected object of interest array
  const [ooiarray, setooiarray] = useState<string[]>([]);
  let arr: string[] = [];
 const {t} = useTranslation();
  // Effect to close dropdown if user clicks outside the menu and not on checkboxes
  useEffect(() => {
    const closeDropdown = (e: MouseEvent) => {
      if (
        e.target instanceof HTMLElement &&
        e.target.id !== menuRef.current?.id &&
        e.target.tagName.toLowerCase() !== 'input' &&
        e.target.id !== "selectooi"
      ) {
        setIsOpen(false);   // Close the dropdown
      }
    };
    document.body.addEventListener('click', closeDropdown);
    return () => document.body.removeEventListener('click', closeDropdown);
  }, [menuRef, setIsOpen]);

  // Open popover click event handler
  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  // Toggle dropdown open/close state
  const toggleDropdown = () => {
    setIsOpen(!isOpen);
  };

  // Close popover click event handler
  const handleClose = () => {
    setAnchorEl(null);
  };

  // Handle checkbox change for item selection
  const handleChange = (id: number, name: string) => {
    arr = ooiarray;
    if (arr.includes(name)) {          // Remove item if already selected
      let arr2 = arr.filter((val) => val !== name);
      setooiarray(arr2);
      setOILable(arr2);
    } else {                         // Add item if not selected
      arr.push(name);
      setOILable(arr);
      setooiarray(arr);
    }
    setCheckedItems({
      ...checkedItems,
      [id]: !checkedItems[id],
    });
  };

  // Popover open state
  const open = Boolean(anchorEl);
  // Popover id for accessibility
  const id = open ? 'simple-popover' : undefined;

  // Normalize text prop to array of unique strings
  text = typeof text === 'string' ? [text] : text;
  text = text && text.filter((item, pos) => text.indexOf(item) === pos);

  // Prepare items list from ooiLabels, excluding empty strings
  let items: { id: number; name: string }[] = [];
  for (let i = 0; i < ooiLabels.length; i++) {
    if (ooiLabels[i] !== "")
      items.push({ id: i, name: ooiLabels[i] });
  }
  // Add "crowd" label if not present
  if (!ooiLabels.includes("crowd")) {
    items.push({ id: ooiLabels.length, name: t("crowd") });
  }

  return (
    <div id="objectOfInterestCls">
      <div className="dropdown" >
        <div
          className={`inner-content text-center ${active === true ? "activeTab" : ""}`}
          key={index}
          id="ooi_button"
          ref={menuRef}
          onClick={(e) => {
            // Reset all tabs to inactive
            for (let i = 0; i < tabStore.length; i++) {
              tabStore[i].active = false;
            }
            // Set current tab active
            tabStore[index].active = true;

            // Update tab store state
            setTabStore(() => {
              return [...tabStore];
            });
            toggleDropdown();
            handleClick(e);
          }}
        >
          {/* Show heading without last character and asterisk if not mobile */}
          {mobile === false && (
            <p id="selectooi">
              <span id="selectooi">{heading.slice(0, -1)}</span>
              <span className='asterics_style'>{heading.charAt(heading.length - 1)}</span>
            </p>
          )}
          {/* Show selected labels or placeholder text */}
          <p className="text-label mb-0 paragah" id="selectooi">
            {ooiarray && ooiarray.length > 0 ? (
              ooiarray.map((ele, idx) => (
                <span key={idx} id="selectooi">
                  {`${ele}${ooiarray.length !== idx + 1 ? ',' : ''}`}
                </span>
              ))
            ) : (
              <span id="selectooi">{t("select objects")}</span>
            )}
          </p>
        </div>
        {/* Dropdown menu with checkboxes */}
        {isOpen && (
          <ul className="dropdown-menu" id="checkbox_menu">
            {items.map((item) => (
              <li key={item.id} id="selectooi">
                <div className="form-check" id="selectooi" onClick={() => handleChange(item.id, item.name)}>
                  <input
                    className="form-check-input"
                    checked={!!checkedItems[item.id]} // checked state from component state
                    type="checkbox"
                    id="selectooi"
                    readOnly
                  />
                  <label
                    className="form-check-label"
                    style={{ fontSize: 18 }}
                    id="selectooi"
                  >
                    {item.name}
                  </label>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}