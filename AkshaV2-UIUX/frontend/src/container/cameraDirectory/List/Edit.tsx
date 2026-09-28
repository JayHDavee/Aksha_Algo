import React, { useState, useEffect, ChangeEvent } from 'react';
import './list.scss';
import { useApi } from '../../../hooks/useApi';
import { useSelector } from 'react-redux';
import Messagebox from '../../../component/common/Messagebox';
import Add from './Add';

const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

/**
 * Interface representing a camera object.
 */
interface Camera {
  _id: string;
  Rtsp_Link: string;
  Camera_Name: string;
  Description?: string;
  Feature?: string;
  Priority?: string;
  Email_Auto_Alert: boolean;
  Display_Auto_Alert: boolean;
  rowselected?: boolean;
}

/**
 * Edit component manages editing of camera details.
 * Handles toggling alerts, adding, editing, deleting cameras.
 * @returns JSX.Element
 */
const Edit: React.FC = () => {
  const { callApi } = useApi();

  const [allselected, setAllselected] = useState<boolean>(false);
  const [cameraList, setCameraList] = useState<Camera[]>([]);
  const [copyCameraList, setCopyCameraList] = useState<Camera[]>([]);
  const [tableloader, setTableloader] = useState<boolean>(false);
  const [cameradata, setCameradata] = useState<Camera | {}>({});
  const [open, setOpen] = useState<boolean>(false);
  const [message, setMessage] = useState<string>('');

  /**
   * Closes the message box.
   */
  const handleClose = (): void => {
    setOpen(false);
  };

  // On component mount, check login and load camera details from localStorage
  useEffect(() => {
    if (localStorage.getItem('isLoggedIn') !== 'true') {
      window.location.assign('/monitor');
      return;
    }
    let data = localStorage.getItem('camera_details');
    if (data) {
      const parsedData = JSON.parse(data);
      if (parsedData.length > 0) {
        setCameradata(parsedData);
        console.log('data in Edit = ', parsedData);
      } else {
        window.location.assign('/monitor');
      }
    } else {
      window.location.assign('/monitor');
    }
  }, []);

  // on load component
  useEffect(() => {
    getcameralist();
  }, []);


  /**
   * Fetches the list of active cameras from the backend.
   */
  const getcameralist = (): void => {
    let url = `${VITE_base_url}${import.meta.env.VITE_CAMERA}`;
    setTableloader(true);
    callApi(url, { method: 'GET' })
      .then((response: any) => {
        const arr: Camera[] = [];
        for (const item of response.data.cameras) {
          if (item.Active === true) {
            item.rowselected = allselected;
            arr.push(item);
          }
        }
        setCameraList(arr.reverse());
        setCopyCameraList(response.data.cameras);
        setTableloader(false);
      })
      .catch(() => {
        setTableloader(false);
      });
  };

  return (
    <>
      <Messagebox
        open={open}
        handleClose={handleClose}
        message={message}
      />
      <section className='camera-directory-list-section' style={{ marginTop: 20 }}>
        {/* @ts-ignore */}
        {(copyCameraList.length > 0 && cameradata && (cameradata as Camera[]).length > 0) && (
          <Add
            showScreen={() => window.location.assign('/monitor')}
            loadlist={() => getcameralist()}
            cameradata={(cameradata as Camera[])[0]}
            list={copyCameraList}
            activescreen={'edit'}
            setMessage={setMessage}
            setOpen={setOpen}
            redirectOnSuccess={() => window.location.assign('/monitor')}
            renderedFrom={'Live'}
          />
        )}
      </section>
    </>
  );
};

export default Edit;