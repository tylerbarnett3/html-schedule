import wixData from 'wix-data';

const APP_VERSION = 'v2.3';
const SHIFT_RETENTION_DAYS = 90;

$w.onReady(function () {
    const iframe = $w('#html1');
    console.log(`Schedule Edit Backend Version: ${APP_VERSION}`);
    hideQuickActionBar();

    iframe.onMessage(async (event) => {
        const { action, data } = event.data;
        
        if (action === 'SYNC_TO_DATABASE') {
            try {
                const syncResult = await syncToDatabase(data);
                const cleanup = await pruneOldShifts();
                iframe.postMessage({ action: 'SYNC_COMPLETE', appVersion: APP_VERSION, cleanup, syncResult });
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
        } else if (action === 'DEDUPLICATE_SHIFTS') {
            try {
                const result = await deduplicateShifts();
                iframe.postMessage({ action: 'DEDUPLICATE_SHIFTS_COMPLETE', result });
            } catch (error) {
                console.error('Shift dedupe failed:', error);
                iframe.postMessage({ action: 'DEDUPLICATE_SHIFTS_ERROR', message: error.message });
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

function hideQuickActionBar() {
    try {
        $w('#quickActionBar1').hide();
    } catch (error) {
        console.warn('Quick action bar was not hidden:', error.message);
    }
}

async function syncToDatabase(data) {
    validateSyncPayload(data);

    try {
        const syncResult = {
            employees: {},
            rates: {},
            shifts: {}
        };

        // ===== SYNC EMPLOYEES =====
        const existingEmployees = await wixData.query('Employees').limit(1000).find();
        const existingEmpMap = new Map(existingEmployees.items.map(e => [e._id, e]));
        const existingEmpByName = new Map(existingEmployees.items.map(e => [normalizeKeyValue(e.name), e]));
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
                const employeeData = {
                    name: emp.name,
                    archived: emp.archived || false,
                    color: emp.color || '#7F6C50',
                    displayOrder: typeof emp.displayOrder === 'number' ? emp.displayOrder : 0
                };
                const existingEmployee = existingEmpByName.get(normalizeKeyValue(emp.name));
                if (existingEmployee) {
                    employeesToUpdate.push({
                        _id: existingEmployee._id,
                        ...employeeData
                    });
                    employeeIdMap[emp.id] = existingEmployee._id;
                    syncResult.employees[emp.id] = existingEmployee._id;
                } else {
                    employeesToInsert.push({
                        localId: emp.id,
                        data: employeeData
                    });
                }
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
                const localId = employeesToInsert[index].localId;
                employeeIdMap[localId] = wixId;
                syncResult.employees[localId] = wixId;
            });
        }
        
        // Sync never deletes records automatically. Manual database deletes are reflected on the next load.
        
        // ===== SYNC RATES =====
        const existingRates = await loadAllEmployeeRates();
        const existingRatesMap = new Map(existingRates.map(r => [r._id, r]));
        const existingRatesByKey = new Map();
        existingRates.forEach(rate => {
            const key = getRateDedupeKey(rate);
            if (!existingRatesByKey.has(key)) {
                existingRatesByKey.set(key, rate);
            }
        });
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
                        const rateData = {
                            employee: wixEmpId,
                            rate: rate.rate,
                            startDate: rate.startDate || null,
                            endDate: rate.endDate || null
                        };
                        const existingRate = existingRatesByKey.get(getRateDedupeKey(rateData));
                        if (existingRate) {
                            desiredRateWixIds.add(existingRate._id);
                            syncResult.rates[getRateClientKey(emp.id, rate)] = existingRate._id;
                            ratesToUpdate.push({
                                _id: existingRate._id,
                                ...rateData
                            });
                        } else {
                            ratesToInsert.push({
                                clientKey: getRateClientKey(emp.id, rate),
                                data: rateData
                            });
                        }
                    }
                }
            }
        }
        
        if (ratesToUpdate.length > 0) {
            await wixData.bulkUpdate('EmployeeRates', ratesToUpdate);
        }
        
        if (ratesToInsert.length > 0) {
            const results = await wixData.bulkInsert('EmployeeRates', ratesToInsert.map(rate => rate.data));
            results.insertedItemIds.forEach((wixId, index) => {
                syncResult.rates[ratesToInsert[index].clientKey] = wixId;
            });
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
        const existingShiftsByKey = buildShiftDedupeMap(allExistingShifts);
        const pendingShiftInsertsByKey = new Map();
        
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
                requestedBy: shift.requestedBy || null,
                timeOffPeriod: shift.timeOffPeriod || 'full-day'
            };
            
            if (shift.wixId) {
                if (existingShiftsMap.has(shift.wixId)) {
                    shiftsToUpdate.push({
                        _id: shift.wixId,
                        ...shiftData
                    });
                    syncResult.shifts[shift.id] = shift.wixId;
                } else {
                    console.warn('Skipping shift with missing Wix ID:', shift.wixId);
                }
            } else {
                const shiftKey = getShiftDedupeKey(shiftData);
                const existingShift = existingShiftsByKey.get(shiftKey);
                if (existingShift) {
                    shiftsToUpdate.push({
                        _id: existingShift._id,
                        ...shiftData
                    });
                    syncResult.shifts[shift.id] = existingShift._id;
                } else {
                    const pendingShift = pendingShiftInsertsByKey.get(shiftKey);
                    if (pendingShift) {
                        pendingShift.localIds.push(shift.id);
                    } else {
                        const shiftToInsert = {
                            localIds: [shift.id],
                            data: shiftData,
                            dedupeKey: shiftKey
                        };
                        shiftsToInsert.push(shiftToInsert);
                        pendingShiftInsertsByKey.set(shiftKey, shiftToInsert);
                    }
                }
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
                const results = await wixData.bulkInsert('Shifts', batch.map(shift => shift.data));
                results.insertedItemIds.forEach((wixId, index) => {
                    const shift = batch[index];
                    shift.localIds.forEach(localId => {
                        syncResult.shifts[localId] = wixId;
                    });
                    existingShiftsByKey.set(shift.dedupeKey, {
                        _id: wixId,
                        ...shift.data
                    });
                });
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

        return syncResult;
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

function normalizeKeyValue(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

function normalizeBoolean(value) {
    return value ? '1' : '0';
}

function getReferenceId(value) {
    return value?._id || value || '';
}

function getRateClientKey(employeeLocalId, rate) {
    return [
        employeeLocalId,
        normalizeKeyValue(rate.rate),
        normalizeKeyValue(rate.startDate),
        normalizeKeyValue(rate.endDate)
    ].join('|');
}

function getRateDedupeKey(rate) {
    return [
        getReferenceId(rate.employee),
        normalizeKeyValue(rate.rate),
        normalizeKeyValue(rate.startDate),
        normalizeKeyValue(rate.endDate)
    ].join('|');
}

function getShiftDedupeKey(shift) {
    return [
        getReferenceId(shift.employee),
        normalizeKeyValue(shift.date),
        normalizeKeyValue(shift.startTime),
        normalizeKeyValue(shift.endTime),
        normalizeBoolean(shift.isDayOff),
        normalizeBoolean(shift.isTimeOffRequest),
        normalizeKeyValue(shift.requestStatus),
        normalizeKeyValue(shift.requestDate),
        normalizeKeyValue(shift.requestedBy),
        normalizeKeyValue(shift.timeOffPeriod || 'full-day')
    ].join('|');
}

function buildShiftDedupeMap(shifts) {
    const shiftsByKey = new Map();
    for (const shift of shifts) {
        const key = getShiftDedupeKey(shift);
        if (!shiftsByKey.has(key) || shouldPreferShift(shift, shiftsByKey.get(key))) {
            shiftsByKey.set(key, shift);
        }
    }
    return shiftsByKey;
}

function shouldPreferShift(candidate, current) {
    if (!current) return true;

    const candidateScore = getShiftCompletenessScore(candidate);
    const currentScore = getShiftCompletenessScore(current);
    if (candidateScore !== currentScore) {
        return candidateScore > currentScore;
    }

    const candidateCreated = new Date(candidate._createdDate || 0).getTime();
    const currentCreated = new Date(current._createdDate || 0).getTime();
    return candidateCreated < currentCreated;
}

function getShiftCompletenessScore(shift) {
    return [
        shift.employee,
        shift.date,
        shift.startTime,
        shift.endTime,
        shift.requestStatus,
        shift.requestDate,
        shift.requestedBy,
        shift.timeOffPeriod
    ].filter(value => value !== undefined && value !== null && value !== '').length;
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

async function deduplicateShifts() {
    const allShifts = await loadAllByQuery(wixData.query('Shifts').limit(100));
    const groups = new Map();

    allShifts.forEach(shift => {
        const key = getShiftDedupeKey(shift);
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(shift);
    });

    const idsToRemove = [];
    groups.forEach(group => {
        if (group.length < 2) return;

        const keeper = group.reduce((best, shift) => (
            shouldPreferShift(shift, best) ? shift : best
        ), group[0]);

        group
            .filter(shift => shift._id !== keeper._id)
            .forEach(shift => idsToRemove.push(shift._id));
    });

    await bulkRemoveByIds('Shifts', idsToRemove);

    return {
        duplicateGroups: [...groups.values()].filter(group => group.length > 1).length,
        deletedCount: idsToRemove.length
    };
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
        const allAvailability = await loadAllAvailability();
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
                requestedBy: shift.requestedBy || null,
                timeOffPeriod: shift.timeOffPeriod || 'full-day'
            };
        }).filter(shift => shift.employeeId !== undefined); // Filter out shifts with no valid employee

        const availabilityData = allAvailability.map((item, index) => {
            const wixEmployeeId = item.employee._id || item.employee;
            const localEmployeeId = employeeIdMap[wixEmployeeId];
            const employee = employeesData.find(e => e.id === localEmployeeId);

            return {
                id: Date.now() + index + 200000,
                wixId: item._id,
                employeeId: localEmployeeId,
                employeeName: employee?.name || 'Unknown',
                date: item.date,
                availabilityPeriod: normalizeTimeOffPeriod(item.availabilityPeriod),
                submittedAt: item.submittedAt || null,
                submittedBy: item.submittedBy || employee?.name || null
            };
        }).filter(item => item.employeeId !== undefined);
        
        $w('#html1').postMessage({
            action: 'LOAD_COMPLETE',
            employees: employeesData,
            shifts: shiftsData,
            availability: availabilityData,
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

async function loadAllAvailability() {
    let allAvailability = [];
    let availabilityQuery = wixData.query('Availability')
        .include('employee')
        .limit(100);
    let availabilityResult = await availabilityQuery.find();
    allAvailability = allAvailability.concat(availabilityResult.items);

    while (availabilityResult.hasNext()) {
        availabilityResult = await availabilityResult.next();
        allAvailability = allAvailability.concat(availabilityResult.items);
    }

    return allAvailability;
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
