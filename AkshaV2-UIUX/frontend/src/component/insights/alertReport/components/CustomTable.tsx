/**
 * Custom table component for displaying alert report data
 * @module CustomTable
 */

import React from 'react';

import './styles/CustomTable.scss'
import CustomTableBody from './CustomTableBody';
import { ReportData } from '../types';
import { useTranslation } from 'react-i18next';
/**
 * Props interface for CustomTable component
 */
interface CustomTableProps {
  /** Report data containing camera information and alerts */
  data: ReportData;
  /** Callback function to show modal with image */
  showModal: (image: string) => void;
}

/**
 * Custom table component that displays alert report data
 * @param {CustomTableProps} props - Component props
 * @returns {JSX.Element} Custom table component
 */
const CustomTable: React.FC<CustomTableProps> = ({ data, showModal }) => {
  const {t} = useTranslation();
  console.log('data', data);
  return (
    <div id="custom-report-table-y-container">
      <table>
        <thead>
          <tr>
            <th></th>
            <th>{t("CAMERA")}</th>
            <th>{t("DATE")}</th>
            <th>{t("TIME")}</th>
            <th>{t("ALERT")}</th>
            <th>{t("LINK")}</th>
          </tr>
        </thead>

        {/* CustomTable.tsx */}
{Object.keys(data?.cameras || {}).map(camName => (
  <CustomTableBody
    key={camName}
    camName={camName}
    data={data.cameras}
    showModal={showModal}
  />
))}

      </table>
    </div>
  );
};

export default CustomTable;
