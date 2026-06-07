import wixData from 'wix-data';

const APP_VERSION = '2026-06-04-reliability-v1';

$w.onReady(function () {
    const iframe = $w('#html1');
    console.log(`Schedule View Backend Version: ${APP_VERSION}`);
    hideQuickActionBar();
    
    // Set up message listener
    iframe.onMessage(async (event) => {
        const { action } = event.data;
        
        if (action === 'LOAD_FROM_DATABASE') {
            await loadFromDatabase();
        }

        // Handle time-off request submission
        if (action === 'SUBMIT_TIME_OFF_REQUEST') {
            await handleTimeOffRequest(event.data.data);
        }
        
        // Handle time-off request cancellation
        if (action === 'CANCEL_TIME_OFF_REQUEST') {
            await handleCancelRequest(event.data.shiftData);
        }
    });
    
    // Also try to load immediately on page ready
    setTimeout(async () => {
        await loadFromDatabase();
    }, 1000);
});

function hideQuickActionBar() {
    try {
        $w('#quickActionBar1').hide();
    } catch (error) {
        console.warn('Quick action bar was not hidden:', error.message);
    }
}

async function loadFromDatabase() {
    try {
        // Load ALL employees
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

        const closedDays = normalizeClosedDays(
            (await loadAllClosedDays()).map(day => day.date)
        );
        
        // Create employee ID mapping
        const employeeIdMap = {};
        const employeesData = [];
        
        for (let i = 0; i < employeeItems.length; i++) {
            const emp = employeeItems[i];
            const localId = Date.now() + i;
            
            employeeIdMap[emp._id] = localId;
            
            // NO RATES IN EMPLOYEE VIEW - employees should not see each other's rates
            employeesData.push({
                id: localId,
                name: emp.name,
                archived: emp.archived || false,
                color: emp.color || '#7F6C50',
                displayOrder: typeof emp.displayOrder === 'number' ? emp.displayOrder : i,
                rates: [] // Empty rates array for employee view
            });
        }
        
        // Convert shifts
        const shiftsData = allShifts.map((shift, index) => {
            const wixEmployeeId = shift.employee._id || shift.employee;
            const localEmployeeId = employeeIdMap[wixEmployeeId];
            const employee = employeesData.find(e => e.id === localEmployeeId);
            
            return {
                id: Date.now() + index + 100000,
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
        }).filter(shift => shift.employeeId !== undefined);
        
        $w('#html1').postMessage({
            action: 'LOAD_COMPLETE',
            employees: employeesData,
            shifts: shiftsData,
            closedDays: closedDays,
            appVersion: APP_VERSION
        });
        
    } catch (error) {
        console.error('Load error:', error);
    }
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

function normalizeClosedDays(days) {
    return [...new Set((days || []).map(day => {
        if (!day) return null;
        if (day instanceof Date) return day.toISOString().split('T')[0];
        const value = String(day);
        return value.includes('T') ? value.split('T')[0] : value;
    }).filter(Boolean))].sort();
}

async function handleTimeOffRequest(requestData) {
    const { employeeId, employeeName, dates, requestDate } = requestData;
    
    try {
        // FIRST: Find the Wix database ID for this employee
        const employeeQuery = await wixData.query('Employees')
            .eq('name', employeeName)
            .find();
        
        if (employeeQuery.items.length === 0) {
            console.error('❌ Employee not found in database:', employeeName);
            $w('#html1').postMessage({ 
                action: 'TIME_OFF_ERROR', 
                message: 'Employee not found in database' 
            });
            return;
        }
        
        const wixEmployeeId = employeeQuery.items[0]._id;
        
        const skippedDates = [];
        const submittedDates = [];
        const closedDays = normalizeClosedDays(
            (await loadAllClosedDays()).map(day => day.date)
        );
        const closedDateSet = new Set(closedDays);

        // Insert a shift for each non-conflicting date.
        for (let date of dates) {
            if (closedDateSet.has(date)) {
                skippedDates.push(date);
                continue;
            }

            const existingRequest = await wixData.query('Shifts')
                .eq('employee', wixEmployeeId)
                .eq('date', date)
                .eq('isTimeOffRequest', true)
                .hasSome('requestStatus', ['pending', 'approved'])
                .find();

            if (existingRequest.items.length > 0) {
                skippedDates.push(date);
                continue;
            }

            await wixData.insert('Shifts', {
                employee: wixEmployeeId, // Use the WIX database ID, not local ID
                date: date,
                startTime: null,
                endTime: null,
                isDayOff: false,
                isTimeOffRequest: true,
                requestStatus: 'pending',
                requestDate: requestDate,
                requestedBy: employeeName
            });
            submittedDates.push(date);
        }
        
        // Notify iframe of success
        $w('#html1').postMessage({
            action: 'TIME_OFF_REQUEST_SUBMITTED',
            submittedDates,
            skippedDates
        });
        
        // Reload data to show the new request
        await loadFromDatabase();
        
    } catch (error) {
        console.error('❌ Error submitting time-off request:', error);
        $w('#html1').postMessage({ 
            action: 'TIME_OFF_ERROR', 
            message: error.message 
        });
    }
}

async function handleCancelRequest(shiftData) {
    try {
        const { employeeName, date } = shiftData;
        
        // Query to find the exact shift using employee reference
        // First find the employee's Wix ID
        const employeeQuery = await wixData.query('Employees')
            .eq('name', employeeName)
            .find();
        
        if (employeeQuery.items.length === 0) {
            console.error('❌ Employee not found in database');
            $w('#html1').postMessage({ 
                action: 'CANCEL_ERROR', 
                message: 'Employee not found in database' 
            });
            return;
        }
        
        const wixEmployeeId = employeeQuery.items[0]._id;
        
        // Query shifts using the employee reference field
        const shiftsResult = await wixData.query('Shifts')
            .eq('employee', wixEmployeeId)
            .eq('date', date)
            .eq('isTimeOffRequest', true)
            .eq('requestStatus', 'pending')
            .find();
        
        if (shiftsResult.items.length > 0) {
            const shiftIds = shiftsResult.items.map(shift => shift._id);
            await wixData.bulkRemove('Shifts', shiftIds);
            
            // Notify iframe of success
            $w('#html1').postMessage({ action: 'TIME_OFF_REQUEST_CANCELLED' });
            
            // Reload data
            await loadFromDatabase();
        } else {
            console.error('❌ Shift not found in database');
            $w('#html1').postMessage({ 
                action: 'CANCEL_ERROR', 
                message: 'Time-off request not found' 
            });
        }
        
    } catch (error) {
        console.error('❌ Error cancelling shift:', error);
        $w('#html1').postMessage({ 
            action: 'CANCEL_ERROR', 
            message: error.message 
        });
    }
}
