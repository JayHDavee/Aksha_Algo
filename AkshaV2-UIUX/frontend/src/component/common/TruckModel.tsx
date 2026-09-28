import { addDays } from 'date-fns';
import { useEffect, useState } from 'react';
import 'react-date-range/dist/styles.css';
import 'react-date-range/dist/theme/default.css';
import './styles/TruckModel.scss';
import { useSelector } from 'react-redux';

interface TruckModelProps {
  setTabStore: (tabs: any[]) => void;
  tabStore: any[];
  index: number;
  close: () => void;
  setDefaultval: (val: string[] | string) => void;
  selectedOption: string[];
  setOILable: (val: string[]) => void;
}

/**
 * TruckModel Component
 *
 * Stateless dropdown component that allows users to select Object of Interest labels.
 * Uses Redux state for available labels and syncs selected values with localStorage and sessionStorage.
 *
 * Known issues:
 * - Active CSS styling does not persist correctly on refresh
 * - localStorage 'OBI' key is not always in sync with UI or axios request parameters
 */
const TruckModel: React.FC<TruckModelProps> = ({
  setTabStore,
  tabStore,
  index,
  close,
  setDefaultval,
  selectedOption,
  setOILable,
}) => {
  const objectOfInterestLabels: string[] = useSelector(
    (state: any) => state.investigation.allObjectOfInterestLabels
  );

  const [state] = useState([
    {
      startDate: new Date(),
      endDate: addDays(new Date(), 0),
      key: 'selection',
    },
  ]);

  const [selectedValue, setSelectedValue] = useState<string[]>(
    selectedOption.length > 0 ? selectedOption : ['person']
  );

  // On initial mount, set default values and store to sessionStorage (unused currently)
  useEffect(() => {
    let data = selectedOption.length > 0 ? [...selectedOption] : [objectOfInterestLabels[0]?.trim()];
    sessionStorage.setItem('OBI', JSON.stringify(data));
  }, []);

  // On mount or change, update tabStore with selected values
  useEffect(() => {
    if (!selectedOption) {
      setDefaultval(objectOfInterestLabels[0] || '');
    }
    tabStore[index].text = selectedOption.length > 0 ? selectedOption : objectOfInterestLabels[0] || '';
    setTabStore([...tabStore]);
    sessionStorage.setItem(
      'OBI',
      JSON.stringify(
        selectedOption.length > 0 ? [...selectedOption] : [objectOfInterestLabels[0]?.trim()]
      )
    );
  }, []);

  /**
   * Called when user clicks on a label.
   * Handles logic to toggle selection, sync with localStorage, and update parent state.
   */
  const showSelected = (val: string) => {
    const existing = JSON.parse(localStorage.getItem('OBI') || '[]') as string[];
    const cleanedExisting = existing.map((item) => item.replace('\r', ''));

    let newArr: string[] = [];
    if (cleanedExisting.includes(val)) {
      newArr = cleanedExisting.filter((item) => item !== val);
    } else {
      newArr = [...cleanedExisting, val];
    }

    setOILable(newArr);
    localStorage.setItem('OBI', JSON.stringify(newArr));
    setSelectedValue(newArr);
    setDefaultval(newArr);

    tabStore[index].text = newArr;
    setTabStore([...tabStore]);

    close();
  };

  const OBI = JSON.parse(localStorage.getItem('OBI') || '[]') as string[];

  return (
    <div className="object-of-interest-outer-wrapper">
      <ul>
        {objectOfInterestLabels.map((label, idx) => {
          const text = label.trim();
          return (
            <li
              key={idx}
              className={OBI.includes(text) ? 'active' : ''}
              onClick={() => showSelected(text)}
            >
              <p>{text}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default TruckModel;
