import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { useApi } from '../../hooks/useApi';
import AddGroup from './List/AddGroup'; // Assumes AddGroup component exists
import Edit from './List/Edit';
import useRemoveScroll from '../../hooks/useRemoveScroll';
import './List/list.scss';
import { CircularProgress } from '@mui/material';
import Box from '@mui/material/Box';
import Messagebox from '../../component/common/Messagebox';
import Modal from 'react-bootstrap/Modal';
import Button from 'react-bootstrap/Button';
import CameraGroupPanel from './CameraGroupPanel'; // Panel that renders the list & controls
import { useTranslation } from 'react-i18next';

const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

/**
 * Camera inside a group
 */
interface GroupCamera {
  camera_id?: string;
  camera_name: string;
  custom_order?: number;
}

/**
 * Camera Group schema
 */
export interface CameraGroupType {
  _id: string;
  group_name: string;
  description?: string;
  priority_type?: string;
  cameras: GroupCamera[];
  created_at?: string;
  updated_at?: string;
  // UI helpers
  rowselected?: boolean;
}

/**
 * Props for the top-level CameraGroup component (similar to your Camera component)
 */
interface ListProps {
  camDirectory: boolean;
  setCamDirectory: (value: boolean) => void;
  setActiveTab: (tab: "directory" | "group") => void;
}

const CameraGroup: React.FC<ListProps> = (props) => {
  const { callApi } = useApi();
  const { t } = useTranslation();

  // Redux - detect mobile
  const { is_mobile } = useSelector((state: any) => state.isMobileDevice);

  // State
  const [activescreen, setActivescreen] = useState<number>(0); // 0 = list, 1 = add/edit
  const [allselected, setAllselected] = useState<boolean>(false);
  const [groupList, setGroupList] = useState<CameraGroupType[]>([]);
  const [copyGroupList, setCopyGroupList] = useState<CameraGroupType[]>([]);
  const [tableloader, setTableloader] = useState<boolean>(false);
  const [groupData, setGroupData] = useState<Partial<CameraGroupType>>({});
  const [groupId, setGroupId] = useState<string>('');
  const [deletemodalstatus, setDeletemodalstatus] = useState<boolean>(false);
  const [viewmodalstatus, setViewModalStatus] = useState<boolean>(false);
  const [viewdata, setViewdata] = useState<Partial<CameraGroupType>>({});
  const [activepage, setActivepage] = useState<string>('add'); // 'view' or '' for add/edit mode ('add','edit')
  const [open, setOpen] = useState<boolean>(false);
  const [message, setMessage] = useState<string>('');
  const [warning, setWarning] = useState<boolean>(false);
  const [deleteItem, setDeleteItem] = useState<CameraGroupType | null>(null);


  // Helper: close messagebox
  const handleClose = () => setOpen(false);

  useEffect(() => {
    // redirect if not logged in (keeps same behaviour as camera file)
    if (localStorage.getItem('isLoggedIn') !== 'true') {
      window.location.assign('/monitor');
      return;
    }
    // initial load
    getGroupList();
  }, []);

  /**
   * Toggle select all groups (mark rowselected on each)
   */
  const handleSelectAll = (): void => {
    setAllselected(!allselected);
    groupList.forEach(g => {
      g.rowselected = !allselected;
    });
    setGroupList([...groupList]);
  };

  /**
   * Toggle single group row selection
   */
  const onChangeSingleRowSelected = (id: string): void => {
    const arr = groupList.map(g => {
      if (g._id === id) g.rowselected = !g.rowselected;
      return g;
    });
    setGroupList(arr);
  };

  /**
   * Fetch camera group list
   */
  const getGroupList = (): void => {
    const url = `${VITE_base_url}/api/camgroup`;
    setTableloader(true);
    callApi(url, { method: 'GET' })
      .then((response) => {
        console.log(response);
        // expect response.data.groups array or response.data.cameraGroups
        const raw = response.data?.groups ?? response.data?.cameraGroups ?? response.data;
        const arr: CameraGroupType[] = [];
        if (Array.isArray(raw)) {
          for (const item of raw) {
            // normalize — ensure fields exist
            const group: CameraGroupType = {
              _id: item._id || item.id || '',
              group_name: item.group_name || item.groupName || '',
              description: item.description || '',
              priority_type: item.priority_type || item.priorityType || '',
              cameras: item.cameras || [],
              created_at: item.created_at || item.createdAt,
              updated_at: item.updated_at || item.updatedAt,
              rowselected: allselected,
            };
            arr.push(group);
          }
        }
        // Sort by priority_type if you want custom ordering; keep nominal order otherwise
        // e.g. custom => 1, high => 2, medium => 3, low => 4
        const priorityOrder: Record<string, number> = { Custom: 1, High: 2, Medium: 3, Low: 4 };
        const sorted = arr.sort((a, b) => {
          const pa = priorityOrder[a.priority_type ?? 'Custom'] ?? 99;
          const pb = priorityOrder[b.priority_type ?? 'Custom'] ?? 99;
          return pa - pb;
        });

        setGroupList(sorted);
        setCopyGroupList(sorted);
        setTableloader(false);
      })
      .catch((err) => {
        console.error('getGroupList error', err);
        setTableloader(false);
        setMessage(t('genericError'));
        setOpen(true);
      });
  };

  /**
   * Show the add/edit page (add)
   */
  const showAddGroup = (): void => {
    setGroupData({});
    console.log("✅ showAddGroup triggered");
    props.setActiveTab("group");
    props.setCamDirectory(false);
    setActivepage('add');
    setActivescreen(1);
  };

  /**
   * Show edit page for a group
   */
  const showeditpage = (item: CameraGroupType): void => {
    console.log("EDIT ITEM:", item);

    const fixed = {
      ...item,
      priority_type: item.priority_type || "Custom",
    };

    setGroupData(fixed);
    props.setActiveTab("group");
    props.setCamDirectory(false);
    setActivepage('edit');
    setActivescreen(1);
  };


  /**
   * Show view (read-only) page for a group
   */
  const showviewpage = (item: CameraGroupType): void => {
    setGroupData(item);
    setActivepage('view');
    props.setActiveTab("group");
    props.setCamDirectory(false);
    setActivescreen(1);
  };

  /**
   * Show delete confirmation
   */
  const showdeletemodal = (item: CameraGroupType): void => {
    setDeletemodalstatus(true);
    setGroupId(item._id);
    setDeleteItem(item); // store full item for DynamoDB sync
  };

  /**
   * Hide delete modal
   */
  const hide_delete_modal = (): void => {
    setDeletemodalstatus(false);
    setGroupId('');
  };

  /**
   * Delete group
   */
  const delete_group = (): void => {
    if (!groupId) return;
    setTableloader(true);

    callApi(`${VITE_base_url}/api/notification`, { method: 'GET' })
      .then((res: any) => {
        const notifications: any[] = res.data?.data ?? [];

        const matchedNotif = notifications.find((n: any) => {
          const id = typeof n.camera_group_id === 'object'
            ? n.camera_group_id?._id
            : n.camera_group_id;
          return id === groupId;
        });

        const mobileIds = matchedNotif?.mobile_app?.mobile_ids ?? "";
        const groupName = deleteItem?.group_name ?? "";

        return callApi(`${VITE_base_url}/api/camgroup/${groupId}`, { method: 'DELETE' })
          .then((deleteRes: any) => ({ deleteRes, mobileIds, groupName }));
      })
      .then(({ deleteRes, mobileIds, groupName }) => {
        if (deleteRes.data?.success === true || deleteRes.status === 200) {

          if (mobileIds && groupId) {
            callApi(`${import.meta.env.VITE_AUTHENCTICATE_USER}/mobile/update-groups`, {
              method: 'POST',
              body: {
                mobile_ids: mobileIds,
                group_id: groupId,
                group_name: groupName,
                action: 'remove',
              },
            }).catch((err: any) =>
              console.error('DynamoDB sync failed:', err)
            );
          }

          setMessage(t('Camera group deleted successfully.'));
          setOpen(true);
          setDeletemodalstatus(false);
          setDeleteItem(null);
          getGroupList();
        } else {
          setMessage(deleteRes.data?.message || t('genericError'));
          setOpen(true);
        }
        setTableloader(false);
      })
      .catch((err) => {
        console.error('delete_group error', err);
        setMessage(t('genericError'));
        setOpen(true);
        setTableloader(false);
      });
  };

  // Disable default scroll when list is small like in camera component
  const dependencyArray = activescreen === 0 && groupList?.length >= 0 && groupList?.length <= 3 ? [] : [1];
  useRemoveScroll(dependencyArray);


  return (
    <section className='camera-directory-list-section' style={{ marginTop: -15 }}>
      {activescreen === 1 ? (
        <>
          {/* Add/Edit/View Group component */}
          <AddGroup
            showScreen={() => {
              setActivescreen(0);
              setActivepage('add');
              props.setCamDirectory(true);
              props.setActiveTab("group");
            }}
            loadlist={getGroupList}
            groupdata={groupData}
            list={copyGroupList}
            screenMode={activepage}
            setMessage={setMessage}
            setOpen={setOpen}
            setWarning={setWarning}
            setCamDirectory={props.setCamDirectory}
            renderedFrom="CamGroupDirectory"
          />

        </>
      ) : (
        <div className="container widthCls">
          <Messagebox open={open} handleClose={handleClose} message={message} warning={warning} />
          <div className="row top-filter-section">
            {tableloader ? (
              <Box sx={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
                <CircularProgress />
              </Box>
            ) : (
              <CameraGroupPanel
                is_mobile={is_mobile}
                allselected={allselected}
                groupList={groupList}
                isEmpty={groupList.length === 0}
                handleSelectAll={handleSelectAll}
                showAddGroup={showAddGroup}
                onChangeSingleRowSelected={onChangeSingleRowSelected}
                showeditpage={showeditpage}
                showviewpage={showviewpage}
                showdeletemodal={showdeletemodal}
                refreshList={getGroupList}
              />
            )}

            {/* Delete modal */}
            <Modal show={deletemodalstatus} onHide={hide_delete_modal} centered>
              <Modal.Header closeButton>
                <Modal.Title>{t('Delete Confirmation')}</Modal.Title>
              </Modal.Header>
              <Modal.Body>
                <p style={{ padding: '0px 16px', fontSize: 16 }}>
                  {t('Are you sure you want to delete the selected camera group?')}
                </p>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onClick={hide_delete_modal}>
                  {t('Cancel')}
                </Button>
                <button className="deletebutton" onClick={delete_group}>
                  {t('Delete')}
                </button>
              </Modal.Footer>
            </Modal>

            {/* View modal for quick view (optional) */}
            <Modal show={viewmodalstatus} onHide={() => setViewModalStatus(false)} size="lg">
              <Modal.Header closeButton>
                <Modal.Title>{t('Camera Group Details')}</Modal.Title>
              </Modal.Header>
              <Modal.Body>
                <p style={{ padding: '0 0', fontSize: 15 }}>
                  <b>{t('Group name')}:</b> {viewdata?.group_name ?? '---'}<br />
                  <b>{t('Description')}:</b> {viewdata?.description ?? '---'}<br />
                  <b>{t('Priority type')}:</b> {viewdata?.priority_type ?? '---'}<br />
                  <b>{t('Cameras')}:</b>
                  {viewdata?.cameras && viewdata.cameras.length > 0 ? (
                    <ul style={{ margin: '8px 0 0 16px' }}>
                      {viewdata.cameras.map((c: GroupCamera, idx: number) => (
                        <li key={c.camera_id ?? idx}>
                          {c.camera_name} {c.custom_order ? ` (order: ${c.custom_order})` : ''}
                        </li>
                      ))}
                    </ul>
                  ) : ' ---'}<br />
                  <b>{t('Created at')}:</b> {viewdata?.created_at ?? '---'}<br />
                  <b>{t('Updated at')}:</b> {viewdata?.updated_at ?? '---'}<br />
                </p>
              </Modal.Body>
            </Modal>
          </div>
        </div>
      )}
    </section>
  );
};

export default CameraGroup;