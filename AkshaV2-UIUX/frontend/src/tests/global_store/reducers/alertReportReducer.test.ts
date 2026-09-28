import alertReportReducer, { fetchAlertReport, setAlertDate } from '../../../../src/global_store/reducers/alertReportReducer';
import dayjs from 'dayjs';

describe('alertReportReducer', () => {
  const initialState = {
    reportData: {},
    alertDate: dayjs().subtract(1, 'day').format('YYYY-MM-DD'),
  };

  it('should return the initial state', () => {
    expect(alertReportReducer(undefined, { type: undefined })).toEqual(initialState);
  });

  it('should handle fetchAlertReport', () => {
    const reportData = { key: 'value' };
    const action = fetchAlertReport(reportData);
    const expectedState = { ...initialState, reportData };
    expect(alertReportReducer(initialState, action)).toEqual(expectedState);
  });

  it('should handle setAlertDate', () => {
    const newDate = '2023-01-01';
    const action = setAlertDate(newDate);
    const expectedState = { ...initialState, alertDate: newDate };
    expect(alertReportReducer(initialState, action)).toEqual(expectedState);
  });
});
