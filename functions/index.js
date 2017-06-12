var functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);

const pathToMedicineDetails = 'User/{name}/Medicine-Box/Compartment-Details/{pushId}/compartmentDetailsMap/{compartmentNumber}/medicineDetails';
const pathToCompartmentNumber = 'User/{name}/Medicine-Box/Compartment-Details/{pushId}/compartmentDetailsMap/{compartmentNumber}';
const pathToMedicineOrder = 'Medicine-Order/Active/{pushId}';
const pathToMedicineOrderAvailability = 'Medicine-Order/Active/{pushId}/availability';

/*
 When the user add a medicine by specifying the medicine name, the cloud function will
 search based on the name in the pharmacy database, and it will extract the extra info
 and copy into the user's medicine info storage directory in firebase database
 */
exports.addMedicineDataEntry =
    functions.database
        .ref(pathToMedicineDetails)
        .onWrite(function (event) {
            const medicineDetails = event.data.val();
            const getMedicineNamePromise = event.data.ref.child("medicineName").once('value');
            const getDrugStorePromise = event.data.ref.child("drugstore").once('value');

            return Promise.all([getMedicineNamePromise, getDrugStorePromise]).then(function (results) {
                const medicineNameSnapshot = results[0];
                const drugStoreSnapshot = results[1];

                var pharmacyRef = admin.database().ref('Pharmacy/' + drugStoreSnapshot.val() + '/Pharmacy-Medicine-Details');

                pharmacyRef.orderByChild('medicineName').equalTo(medicineNameSnapshot.val()).on('child_added', function (snapshot) {
                    var description = snapshot.child("description").val();
                    var frequencyOfTaking = snapshot.child("frequencyOfTaking").val();
                    var medicineId = snapshot.child("id").val();
                    var medicineImg = snapshot.child("medicineImage").val();
                    var medicineMoreInfo = snapshot.child("medicineMoreInfo").val();
                    var price = snapshot.child("price").val();

                    if (medicineDetails != null) {
                        event.data.ref.child("description").set(description);
                        event.data.ref.child("frequencyOfTaking").set(frequencyOfTaking);
                        event.data.ref.child("id").set(medicineId);
                        event.data.ref.child("medicineImg").set(medicineImg);
                        event.data.ref.child("medicineMoreInfo").set(medicineMoreInfo);
                        event.data.ref.child("price").set(price);
                    } else {
                        return;
                    }
                });
            }, function (errorObject) {
                console.log("The read failed: " + errorObject.code);
            });

        });

/*
 Send follower notification when the runOutAlert is set to true, this indicate the medicine in a compartment
 has run out, the notification will pass the medicineBox id and the compartmentNumber of the drugbox to the
 user
 */
exports.sendFollowerNotification = functions.database.ref(pathToCompartmentNumber).onWrite(function (event) {
    const getRunOutAlertPromise = event.data.ref.child("runOutAlert").once('value');
    const getFCMTokenPromise = admin.database().ref("User/" + event.params.name + "/registrationToken").once('value');

    if (!event.data.val()) {
        return console.log("Error in user :" + event.params.name);
    }
    console.log('Run out alert trigger for user : ' + event.params.name);

    return Promise.all([getRunOutAlertPromise, getFCMTokenPromise]).then(function (results) {
        const runOutAlert = results[0];
        const tokensSnapshot = results[1];

        if (runOutAlert.val() == true) {
            console.log("The token is " + tokensSnapshot.val());

            const getCompartmentDetails = event.data.ref.parent.child(event.params.compartmentNumber).once("value");

            return Promise.all([getCompartmentDetails]).then(function (results) {
                var snapshot = results[0];
                var medicineDetailsSnapShot = snapshot.child("/medicineDetails");

                var fillUpStatus = safeParseString(snapshot.child("fillUpStatus").val());
                //id represents the compartment number
                var id = safeParseString(snapshot.child("id").val());
                var medicineBoxId = safeParseString(snapshot.child("medicineBoxId").val());
                // Notification details.
                const payload = {
                    data: {
                        id: id,
                        medicineBoxId: medicineBoxId,
                        action: "MedicineRunOutAction",
                        userGroup: "User"
                    },
                    notification: {
                        title: event.params.compartmentNumber + " has run out",
                        body: "Do you want to refill online now ?"
                    }
                };
                // Listing all tokens.
                const tokens = tokensSnapshot.val();

// Send notifications to all tokens.
                return admin.messaging().sendToDevice(tokens, payload).then(function (response) {
                    // For each message check if there was an error.
                    const tokensToRemove = [];
                    response.results.forEach(function (result, index) {
                        const error = result.error;
                        if (error) {
                            console.error('Failure sending notification to', tokens[index], error);
                            // Cleanup the tokens who are not registered anymore.
                            if (error.code === 'messaging/invalid-registration-token' ||
                                error.code === 'messaging/registration-token-not-registered') {
                                tokensToRemove.push(tokensSnapshot.ref.child(tokens[index]).remove());
                            }
                        }
                    })
                    ;
                    return Promise.all(tokensToRemove);
                });
            });
        }
    })
});

/*
The function will send notification to the pharmacy that subscribe the topic
 */
exports.sendPharmacyNotification = functions.database.ref(pathToMedicineOrder).onWrite(function (event) {

    const snapshot = event.data;

    //we only send notification when there is new medicine order added
    if (snapshot.previous.val()) {
        return;
    }

    const payload = {
        data: {
            action: "NewMedicineOrderAction",
            userGroup: "Pharmacy"
        },
        notification: {
            title: "New order comes in",
            body: "Click to know more !"
        }
    };

    return admin.messaging().sendToTopic("medicineOrder", payload);
});

/*
After the pharmacy accept a particular medicine order, we will convert the order from the active list to inactive list
 */
exports.convertOrderToInactive = functions.database.ref(pathToMedicineOrderAvailability).onWrite(function (event) {

    const availability = event.data.val();
    const getMedicineOrderPromise = event.data.ref.parent.once("value");
    console.log(availability);
    return Promise.all([getMedicineOrderPromise]).then(function (results) {
        var medicineOrderSnapshot = results[0];
        console.log(medicineOrderSnapshot.val());
        if (availability == false) {
            var medicineOrderRef = admin.database().ref('Medicine-Order');
            var medicineOrder = medicineOrderSnapshot.val();
            medicineOrderRef.child("Inactive").child(medicineOrder.id).set(medicineOrderSnapshot.val());
        }

        var userNameRef = admin.database().ref("User/" + medicineOrder.userName).child("registrationToken");
        var getRegistrationTokenPromise = userNameRef.once("value");
        return Promise.all([getRegistrationTokenPromise]).then(function (results) {
            var registrationTokenSnapshot = results[0];
            const token = registrationTokenSnapshot.val();
            const payload = {
                data: {
                    action: "MedicineOrderAcceptedAction",
                    userGroup: "User"
                },
                notification: {
                    title: "Medicine Order Accepted",
                    body: "Just sit still and wait for your medicine !"
                }
            };
            event.data.ref.parent.remove();
            return admin.messaging().sendToDevice(token, payload);
        });
    });
});

function sendNotification(token, payload) {
    return admin.messaging().sendToDevice(token, payload).then(function (response) {
        // For each message check if there was an error.
        const tokensToRemove = [];
        response.results.forEach(function (result, index) {
            const error = result.error;
            if (error) {
                console.error('Failure sending notification to', tokens[index], error);
                // Cleanup the tokens who are not registered anymore.
                if (error.code === 'messaging/invalid-registration-token' ||
                    error.code === 'messaging/registration-token-not-registered') {
                    tokensToRemove.push(tokensSnapshot.ref.child(tokens[index]).remove());
                }
            }
        })
        ;
        return Promise.all(tokensToRemove);
    });
}

function safeParseString(obj) {
    if (obj != null) {
        return obj.toString();
    } else {
        return "";
    }
}