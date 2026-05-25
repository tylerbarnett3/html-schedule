import wixData from 'wix-data';

$w.onReady(function () {
    const iframe = $w('#html1');

    iframe.onMessage(async (event) => {
        const { action, data } = event.data;
        
        if (action === 'SYNC_TO_DATABASE') {
            try {
                await syncToDatabase(data);
                iframe.postMessage({ action: 'SYNC_COMPLETE' });
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
        } else if (action === 'TIME_OFF_REQUEST_SUBMITTED') {
            // When a request is submitted from View page, reload Edit page data
            console.log('🔵 Time-off request was submitted, reloading data...');
            await loadFromDatabase();
        } else if (action === 'TIME_OFF_REQUEST_CANCELLED') {
            // When a request is cancelled from View page, reload Edit page data
            console.log('🔵 Time-off request was cancelled, reloading data...');
            await loadFromDatabase();
        }
    });
});

async function syncToDatabase(data) {
    validateSyncPayload(data);

    console.log('Smart sync starting with:', data.employees.length, 'employees and', data.shifts.length, 'shifts');
    try {
        // ===== SYNC EMPLOYEES =====
        const existingEmployees = await wixData.query('Employees').limit(1000).find();
        const existingEmpMap = new Map(existingEmployees.items.map(e => [e._id, e]));
        const employeeIdMap = {}; // Maps local IDs to Wix IDs
        
        console.log('Found', existingEmployees.items.length, 'existing employees in database');
        
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
                        color: emp.color || '#7F6C50'
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
                        color: emp.color || '#7F6C50'
                    }
                });
            }
        }
        
        // Batch update existing employees
        if (employeesToUpdate.length > 0) {
            console.log('Updating', employeesToUpdate.length, 'employees');
            await wixData.bulkUpdate('Employees', employeesToUpdate);
        }
        
        // Batch insert new employees
        if (employeesToInsert.length > 0) {
            console.log('Inserting', employeesToInsert.length, 'new employees');
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
        
        console.log('Found', existingRates.length, 'existing rates in database');
        
        const ratesToUpdate = [];
        const ratesToInsert = [];

        for (let emp of data.employees) {
            const wixEmpId = employeeIdMap[emp.id];
            if (!wixEmpId) continue;
            
            if (emp.rates && emp.rates.length > 0) {
                for (let rate of emp.rates) {
                    if (rate.wixId) {
                        if (existingRatesMap.has(rate.wixId)) {
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
            console.log('Updating', ratesToUpdate.length, 'rates');
            await wixData.bulkUpdate('EmployeeRates', ratesToUpdate);
        }
        
        if (ratesToInsert.length > 0) {
            console.log('Inserting', ratesToInsert.length, 'new rates');
            await wixData.bulkInsert('EmployeeRates', ratesToInsert);
        }
        
        // Sync never deletes rates automatically. Manual database deletes are reflected on the next load.
        
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
        console.log('Found', allExistingShifts.length, 'existing shifts in database');
        
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
            console.log('Updating', shiftsToUpdate.length, 'shifts');
            // Split into batches of 50 for safety
            for (let i = 0; i < shiftsToUpdate.length; i += 50) {
                const batch = shiftsToUpdate.slice(i, i + 50);
                await wixData.bulkUpdate('Shifts', batch);
            }
        }
        
        // Batch insert shifts
        if (shiftsToInsert.length > 0) {
            console.log('Inserting', shiftsToInsert.length, 'new shifts');
            // Split into batches of 50 for safety
            for (let i = 0; i < shiftsToInsert.length; i += 50) {
                const batch = shiftsToInsert.slice(i, i + 50);
                await wixData.bulkInsert('Shifts', batch);
            }
        }
        
        // Sync never deletes shifts automatically. Shift deletes use DELETE_SHIFT explicitly.
        
        console.log('Smart sync complete!');
    } catch (error) {
        console.error('Sync error:', error);
        throw error;
    }
}

function validateSyncPayload(data) {
    if (!data || !Array.isArray(data.employees) || !Array.isArray(data.shifts)) {
        throw new Error('Invalid sync payload: employees and shifts arrays are required.');
    }

    if (data.employees.length === 0 && data.shifts.length === 0) {
        throw new Error('Refusing to sync empty schedule data. Reload from the database and try again.');
    }
}

async function deleteShiftFromDatabase(data) {
    if (!data || !data.wixId) {
        console.log('No persisted Wix shift ID provided; nothing to delete from database.');
        return;
    }

    await wixData.remove('Shifts', data.wixId);
}

async function loadFromDatabase() {
    try {
        console.log('Loading from database...');
        
        // Load ALL employees in the order they were created
        const employees = await wixData.query('Employees')
            .ascending('_createdDate')
            .limit(1000)
            .find();
        
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
        
        console.log('Loaded employees:', employees.items.length);
        console.log('Loaded shifts:', allShifts.length);
        
        const allRates = await loadAllEmployeeRates();
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
        
        for (let i = 0; i < employees.items.length; i++) {
            const emp = employees.items[i];
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
                rates: rates.map(r => ({
                    wixId: r._id,
                    rate: r.rate,
                    startDate: r.startDate,
                    endDate: r.endDate
                }))
            });
        }

        employeesData.reverse();
        
        console.log('Employee ID map:', employeeIdMap);
        
        // Convert shifts - FIX THE MAPPING
        const shiftsData = allShifts.map((shift, index) => {
            // The shift.employee is an OBJECT when using include(), not just an ID
            const wixEmployeeId = shift.employee._id || shift.employee;
            const localEmployeeId = employeeIdMap[wixEmployeeId];
            const employee = employeesData.find(e => e.id === localEmployeeId);
            
            if (index < 5) { // Only log first 5 for debugging
                console.log(`Shift ${index}: wixId=${wixEmployeeId}, localId=${localEmployeeId}, employee=${employee?.name}`);
            }
            
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
        
        console.log('Sending to iframe:', employeesData.length, 'employees and', shiftsData.length, 'shifts');
        
        $w('#html1').postMessage({
            action: 'LOAD_COMPLETE',
            employees: employeesData,
            shifts: shiftsData
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
