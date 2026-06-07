import wixData from 'wix-data';

const APP_VERSION = '2026-06-04-reliability-v1';
const SHIFT_RETENTION_DAYS = 90;

$w.onReady(function () {
    const iframe = $w('#html1');
    console.log(`Schedule Edit Backend Version: ${APP_VERSION}`);

    iframe.onMessage(async (event) => {
        const { action, data } = event.data;
        
        if (action === 'SYNC_TO_DATABASE') {
            try {
                await syncToDatabase(data);
                const cleanup = await pruneOldShifts();
                iframe.postMessage({ action: 'SYNC_COMPLETE', appVersion: APP_VERSION, cleanup });
            } catch (error) {
                console.error('Sync failed:', error);
                iframe.postMessage({ action: 'SYNC_ERROR', message: error.message });
            }
        } else if (action === 'LOAD_FROM_DATABASE') {
            await loadFromDatabase();
        } else if (action === 'DELETE_SHIFT') {
            try {
                await deleteShiftFromDatabase(data);
                iframe.postMessage({ action: 'DELETE_SHIFT_COMPLETE' });
            } catch (error) {
                console.error('Shift delete failed:', error);
                iframe.postMessage({ action: 'DELETE_SHIFT_ERROR', message: error.message });
            }
        } else if (action === 'DELETE_SHIFTS_FOR_DATES') {
            try {
                await deleteShiftsForDatesFromDatabase(data);
                iframe.postMessage({ action: 'DELETE_SHIFTS_FOR_DATES_COMPLETE' });
            } catch (error) {
                console.error('Closed-day shift delete failed:', error);
                iframe.postMessage({ action: 'DELETE_SHIFTS_FOR_DATES_ERROR', message: error.message });
            }
        } else if (action === 'DELETE_TIME_OFF_REQUESTS') {
            try {
                await deleteTimeOffRequestsFromDatabase(data);
                iframe.postMessage({ action: 'DELETE_TIME_OFF_REQUESTS_COMPLETE' });
            } catch (error) {
                console.error('Time-off request delete failed:', error);
                iframe.postMessage({ action: 'DELETE_TIME_OFF_REQUESTS_ERROR', message: error.message });
            }
        } else if (action === 'DELETE_EMPLOYEE') {
            try {
                await deleteEmployeeFromDatabase(data);
                iframe.postMessage({ action: 'DELETE_EMPLOYEE_COMPLETE' });
            } catch (error) {
                console.error('Employee delete failed:', error);
                iframe.postMessage({ action: 'DELETE_EMPLOYEE_ERROR', message: error.message });
            }
        } else if (action === 'TIME_OFF_REQUEST_SUBMITTED') {
            // When a request is submitted from View page, reload Edit page data
            await loadFromDatabase();
        } else if (action === 'TIME_OFF_REQUEST_CANCELLED') {
            // When a request is cancelled from View page, reload Edit page data
            await loadFromDatabase();
        }
    });
});

async function syncToDatabase(data) {
    validateSyncPayload(data);

    try {
        // ===== SYNC EMPLOYEES =====
        const existingEmployees = await wixData.query('Employees').limit(1000).find();
        const existingEmpMap = new Map(existingEmployees.items.map(e => [e._id, e]));
        const employeeIdMap = {}; // Maps local IDs to Wix IDs
        
        const employeesToUpdate = [];
        const employeesToInsert = [];
        
        // Separate employees into update vs insert
        for (let emp of data.employees) {
            if (emp.wixId) {
                if (existingEmpMap.has(emp.wixId)) {
                    employeesToUpdate.push({
                        _id: emp.wixId,
                        name: emp.name,
                        archived: emp.archived || false,
                        color: emp.color || '#7F6C50',
                        displayOrder: typeof emp.displayOrder === 'number' ? emp.displayOrder : 0
                    });
                    employeeIdMap[emp.id] = emp.wixId;
                } else {
                    console.warn('Skipping employee with missing Wix ID:', emp.wixId);
                }
            } else {
                employeesToInsert.push({
                    localId: emp.id,
                    data: {
                        name: emp.name,
                        archived: emp.archived || false,
                        color: emp.color || '#7F6C50',
                        displayOrder: typeof emp.displayOrder === 'number' ? emp.displayOrder : 0
                    }
                });
            }
        }
        
        // Batch update existing employees
        if (employeesToUpdate.length > 0) {
            await wixData.bulkUpdate('Employees', employeesToUpdate);
        }
        
        // Batch insert new employees
        if (employeesToInsert.length > 0) {
            const insertData = employeesToInsert.map(e => e.data);
            const results = await wixData.bulkInsert('Employees', insertData);
            // Map the results back to local IDs
            results.insertedItemIds.forEach((wixId, index) => {
                employeeIdMap[employeesToInsert[index].localId] = wixId;
            });
        }
        
        // Sync never deletes records automatically. Manual database deletes are reflected on the next load.
        
        // ===== SYNC RATES =====
        const existingRates = await loadAllEmployeeRates();
        const existingRatesMap = new Map(existingRates.map(r => [r._id, r]));
        const syncedEmployeeWixIds = new Set(Object.values(employeeIdMap));
        const desiredRateWixIds = new Set();
        
        const ratesToUpdate = [];
        const ratesToInsert = [];

        for (let emp of data.employees) {
            const wixEmpId = employeeIdMap[emp.id];
            if (!wixEmpId) continue;
            
            if (emp.rates && emp.rates.length > 0) {
                for (let rate of emp.rates) {
                    if (rate.wixId) {
                        if (existingRatesMap.has(rate.wixId)) {
                            desiredRateWixIds.add(rate.wixId);
                            ratesToUpdate.push({
                                _id: rate.wixId,
                                employee: wixEmpId,
                                rate: rate.rate,
                                startDate: rate.startDate || null,
                                endDate: rate.endDate || null
                            });
                        } else {
                            console.warn('Skipping rate with missing Wix ID:', rate.wixId);
                        }
                    } else {
                        ratesToInsert.push({
                            employee: wixEmpId,
                            rate: rate.rate,
                            startDate: rate.startDate || null,
                            endDate: rate.endDate || null
                        });
                    }
                }
            }
        }
        
        if (ratesToUpdate.length > 0) {
            await wixData.bulkUpdate('EmployeeRates', ratesToUpdate);
        }
        
        if (ratesToInsert.length > 0) {
            await wixData.bulkInsert('EmployeeRates', ratesToInsert);
        }
        
        const staleRateIds = existingRates
            .filter(rate => {
                const employeeId = rate.employee?._id || rate.employee;
                return syncedEmployeeWixIds.has(employeeId) && !desiredRateWixIds.has(rate._id);
            })
            .map(rate => rate._id);

        await bulkRemoveByIds('EmployeeRates', staleRateIds);
        
        // ===== SYNC SHIFTS =====
        let allExistingShifts = [];
        let shiftsQuery = wixData.query('Shifts').limit(100);
        let shiftsResult = await shiftsQuery.find();
        allExistingShifts = allExistingShifts.concat(shiftsResult.items);
        
        while (shiftsResult.hasNext()) {
            shiftsResult = await shiftsResult.next();
            allExistingShifts = allExistingShifts.concat(shiftsResult.items);
        }
        
        const existingShiftsMap = new Map(allExistingShifts.map(s => [s._id, s]));
        
        const shiftsToUpdate = [];
        const shiftsToInsert = [];

        for (let shift of data.shifts) {
            const wixEmpId = employeeIdMap[shift.employeeId];
            if (!wixEmpId) {
                console.warn('Skipping shift - no valid employee mapping for employeeId:', shift.employeeId);
                continue;
            }
            
            const shiftData = {
                employee: wixEmpId,
                date: shift.date,
                startTime: shift.startTime,
                endTime: shift.endTime,
                isDayOff: shift.isDayOff || false,
                isTimeOffRequest: shift.isTimeOffRequest || false,
                requestStatus: shift.requestStatus || null,
                requestDate: shift.requestDate || null,
                requestedBy: shift.requestedBy || null
            };
            
            if (shift.wixId) {
                if (existingShiftsMap.has(shift.wixId)) {
                    shiftsToUpdate.push({
                        _id: shift.wixId,
                        ...shiftData
                    });
                } else {
                    console.warn('Skipping shift with missing Wix ID:', shift.wixId);
                }
            } else {
                shiftsToInsert.push(shiftData);
            }
        }
        
        // Batch update shifts
        if (shiftsToUpdate.length > 0) {
            // Split into batches of 50 for safety
            for (let i = 0; i < shiftsToUpdate.length; i += 50) {
                const batch = shiftsToUpdate.slice(i, i + 50);
                await wixData.bulkUpdate('Shifts', batch);
            }
        }
        
        // Batch insert shifts
        if (shiftsToInsert.length > 0) {
            // Split into batches of 50 for safety
            for (let i = 0; i < shiftsToInsert.length; i += 50) {
                const batch = shiftsToInsert.slice(i, i + 50);
                await wixData.bulkInsert('Shifts', batch);
            }
        }
        
        // Sync never deletes shifts automatically. Shift deletes use DELETE_SHIFT explicitly.

        // ===== SYNC CLOSED DAYS =====
        const desiredClosedDays = normalizeClosedDays(data.closedDays || []);
        const existingClosedDays = (await loadAllClosedDays())
            .map(day => ({ ...day, date: normalizeClosedDays([day.date])[0] }))
            .filter(day => day.date);
        const existingClosedDateSet = new Set(existingClosedDays.map(day => day.date));
        const desiredClosedDateSet = new Set(desiredClosedDays);

        const closedDaysToInsert = desiredClosedDays
            .filter(date => !existingClosedDateSet.has(date))
            .map(date => ({ date }));
        const closedDayIdsToRemove = existingClosedDays
            .filter(day => !desiredClosedDateSet.has(day.date))
            .map(day => day._id);

        if (closedDaysToInsert.length > 0) {
            await wixData.bulkInsert('ClosedDays', closedDaysToInsert);
        }

        if (closedDayIdsToRemove.length > 0) {
            await wixData.bulkRemove('ClosedDays', closedDayIdsToRemove);
        }
    } catch (error) {
        console.error('Sync error:', error);
        throw error;
    }
}

function validateSyncPayload(data) {
    if (!data || !Array.isArray(data.employees) || !Array.isArray(data.shifts)) {
        throw new Error('Invalid sync payload: employees and shifts arrays are required.');
    }

    if (data.closedDays !== undefined && !Array.isArray(data.closedDays)) {
        throw new Error('Invalid sync payload: closedDays must be an array.');
    }

    if (data.employees.length === 0 && data.shifts.length === 0 && (!data.closedDays || data.closedDays.length === 0)) {
        throw new Error('Refusing to sync empty schedule data. Reload from the database and try again.');
    }
}

async function deleteShiftFromDatabase(data) {
    if (!data || !data.wixId) {
        return;
    }

    await wixData.remove('Shifts', data.wixId);
}

async function deleteShiftsForDatesFromDatabase(data) {
    const dates = normalizeClosedDays(data?.dates || []);
    if (dates.length === 0) {
        return;
    }

    let shiftsToDelete = [];
    let shiftsQuery = wixData.query('Shifts')
        .hasSome('date', dates)
        .limit(100);

    let shiftsResult = await shiftsQuery.find();
    shiftsToDelete = shiftsToDelete.concat(shiftsResult.items);

    while (shiftsResult.hasNext()) {
        shiftsResult = await shiftsResult.next();
        shiftsToDelete = shiftsToDelete.concat(shiftsResult.items);
    }

    await bulkRemoveByIds('Shifts', shiftsToDelete.map(shift => shift._id));
}

async function deleteTimeOffRequestsFromDatabase(data) {
    const wixIds = Array.isArray(data?.wixIds)
        ? data.wixIds.filter(Boolean)
        : [];

    await bulkRemoveByIds('Shifts', wixIds);
}

async function deleteEmployeeFromDatabase(data) {
    const wixId = data?.wixId;
    if (!wixId) {
        return;
    }

    const [shifts, rates] = await Promise.all([
        loadAllByQuery(wixData.query('Shifts').eq('employee', wixId).limit(100)),
        loadAllByQuery(wixData.query('EmployeeRates').eq('employee', wixId).limit(100))
    ]);

    await bulkRemoveByIds('Shifts', shifts.map(shift => shift._id));
    await bulkRemoveByIds('EmployeeRates', rates.map(rate => rate._id));
    await wixData.remove('Employees', wixId);
}

function normalizeClosedDays(days) {
    return [...new Set((days || []).map(day => {
        if (!day) return null;
        if (day instanceof Date) return day.toISOString().split('T')[0];
        const value = String(day);
        return value.includes('T') ? value.split('T')[0] : value;
    }).filter(Boolean))].sort();
}

async function loadFromDatabase() {
    try {
        const cleanup = await pruneOldShifts();

        // Load ALL employees, then apply saved custom order when present.
        const employees = await wixData.query('Employees')
            .ascending('_createdDate')
            .limit(1000)
            .find();
        const employeeItems = employees.items.slice().reverse().sort((a, b) => {
            const aHasOrder = typeof a.displayOrder === 'number';
            const bHasOrder = typeof b.displayOrder === 'number';
            if (aHasOrder && bHasOrder) return a.displayOrder - b.displayOrder;
            if (aHasOrder) return -1;
            if (bHasOrder) return 1;
            return 0;
        });
        
        // Load ALL shifts
        let allShifts = [];
        let shiftsQuery = wixData.query('Shifts')
            .include('employee')
            .limit(100);
        
        let shiftsResult = await shiftsQuery.find();
        allShifts = allShifts.concat(shiftsResult.items);
        
        while (shiftsResult.hasNext()) {
            shiftsResult = await shiftsResult.next();
            allShifts = allShifts.concat(shiftsResult.items);
        }
        
        const allRates = await loadAllEmployeeRates();
        const closedDays = normalizeClosedDays(
            (await loadAllClosedDays()).map(day => day.date)
        );
        const ratesByEmployeeId = new Map();
        allRates.forEach(rate => {
            const employeeId = rate.employee?._id || rate.employee;
            if (!employeeId) return;
            if (!ratesByEmployeeId.has(employeeId)) {
                ratesByEmployeeId.set(employeeId, []);
            }
            ratesByEmployeeId.get(employeeId).push(rate);
        });
        
        // Create employee ID mapping: Wix ID -> new local ID
        const employeeIdMap = {};
        const employeesData = [];
        
        for (let i = 0; i < employeeItems.length; i++) {
            const emp = employeeItems[i];
            const localId = Date.now() + i;
            
            // Store the mapping
            employeeIdMap[emp._id] = localId;
            
            const rates = ratesByEmployeeId.get(emp._id) || [];

            employeesData.push({
                id: localId,
                wixId: emp._id,
                name: emp.name,
                archived: emp.archived || false,
                color: emp.color || '#7F6C50',
                displayOrder: typeof emp.displayOrder === 'number' ? emp.displayOrder : i,
                rates: rates.map(r => ({
                    wixId: r._id,
                    rate: r.rate,
                    startDate: r.startDate,
                    endDate: r.endDate
                }))
            });
        }

        // Convert shifts - FIX THE MAPPING
        const shiftsData = allShifts.map((shift, index) => {
            // The shift.employee is an OBJECT when using include(), not just an ID
            const wixEmployeeId = shift.employee._id || shift.employee;
            const localEmployeeId = employeeIdMap[wixEmployeeId];
            const employee = employeesData.find(e => e.id === localEmployeeId);
            
            return {
                id: Date.now() + index + 100000,
                wixId: shift._id,
                employeeId: localEmployeeId,
                employeeName: employee?.name || 'Unknown',
                date: shift.date,
                startTime: shift.startTime,
                endTime: shift.endTime,
                isDayOff: shift.isDayOff || false,
                isTimeOffRequest: shift.isTimeOffRequest || false,
                requestStatus: shift.requestStatus || null,
                requestDate: shift.requestDate || null,
                requestedBy: shift.requestedBy || null
            };
        }).filter(shift => shift.employeeId !== undefined); // Filter out shifts with no valid employee
        
        $w('#html1').postMessage({
            action: 'LOAD_COMPLETE',
            employees: employeesData,
            shifts: shiftsData,
            closedDays: closedDays,
            appVersion: APP_VERSION,
            cleanup
        });
        
    } catch (error) {
        console.error('Load error:', error);
    }
}

async function loadAllEmployeeRates() {
    let allRates = [];
    let ratesQuery = wixData.query('EmployeeRates').limit(100);
    let ratesResult = await ratesQuery.find();
    allRates = allRates.concat(ratesResult.items);

    while (ratesResult.hasNext()) {
        ratesResult = await ratesResult.next();
        allRates = allRates.concat(ratesResult.items);
    }

    return allRates;
}

async function loadAllClosedDays() {
    let allClosedDays = [];
    let closedDaysQuery = wixData.query('ClosedDays').limit(100);
    let closedDaysResult = await closedDaysQuery.find();
    allClosedDays = allClosedDays.concat(closedDaysResult.items);

    while (closedDaysResult.hasNext()) {
        closedDaysResult = await closedDaysResult.next();
        allClosedDays = allClosedDays.concat(closedDaysResult.items);
    }

    return allClosedDays;
}

async function pruneOldShifts() {
    const cutoffDate = new Date();
    cutoffDate.setHours(0, 0, 0, 0);
    cutoffDate.setDate(cutoffDate.getDate() - SHIFT_RETENTION_DAYS);
    const cutoff = cutoffDate.toISOString().split('T')[0];

    const oldShifts = await loadAllByQuery(
        wixData.query('Shifts')
            .lt('date', cutoff)
            .limit(100)
    );

    await bulkRemoveByIds('Shifts', oldShifts.map(shift => shift._id));

    return {
        deletedCount: oldShifts.length,
        cutoff,
        retentionDays: SHIFT_RETENTION_DAYS
    };
}

async function loadAllByQuery(query) {
    let allItems = [];
    let result = await query.find();
    allItems = allItems.concat(result.items);

    while (result.hasNext()) {
        result = await result.next();
        allItems = allItems.concat(result.items);
    }

    return allItems;
}

async function bulkRemoveByIds(collectionName, ids) {
    const cleanIds = [...new Set((ids || []).filter(Boolean))];
    for (let i = 0; i < cleanIds.length; i += 50) {
        await wixData.bulkRemove(collectionName, cleanIds.slice(i, i + 50));
    }
}
